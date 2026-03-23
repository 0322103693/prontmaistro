import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { jsPDF } from "jspdf";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mermaid from "mermaid";

const PROMPT_MAESTRO = `Eres el motor de análisis de MindVoice AI.

Objetivo:
1. Recibir audio o texto transcrito.
2. Transcribir si el input es audio.
3. Permitir corrección manual previa al análisis.
4. Generar una salida estructurada para MindVoice.
5. Producir resumen ejecutivo en 3 párrafos, tareas, insights y nodos para mapa mental.

Devuelve JSON válido con esta forma:
{
  "title": "",
  "transcription": "",
  "transcription_with_timestamps": [
    { "start": "00:00", "end": "00:05", "text": "" }
  ],
  "executive_summary": ["", "", ""],
  "edited_text": "",
  "key_insights": [""],
  "task_list": [{ "task": "", "priority": "baja|media|alta" }],
  "mind_map_nodes": [{ "id": "", "label": "", "parentId": null }],
  "tags": [""],
  "semantic_keywords": [""],
  "report_ready_text": ""
}

Reglas:
- No inventes hechos.
- Si falta información, indícalo.
- El resumen ejecutivo debe tener exactamente 3 párrafos.
- Las tareas deben devolverse como array de objetos {task, priority}.
- Los nodos del mapa mental deben estar listos para renderizar con Mermaid.js o librerías similares.
- Si puedes, devuelve transcription_with_timestamps por frase en JSON.`;

const ARCHIVOS_INICIALES = [
  {
    id: "f1",
    name: "Ideas de tesis",
    folder: "Academico/Investigacion",
    tags: ["tesis", "ideas"],
    type: "nota",
    updatedAt: "2026-01-15",
  },
  {
    id: "f2",
    name: "Minuta reunion equipo",
    folder: "Trabajo/Reuniones",
    tags: ["equipo", "acciones"],
    type: "audio",
    updatedAt: "2026-01-14",
  },
  {
    id: "f3",
    name: "Resumen entrevista",
    folder: "Personal/Notas",
    tags: ["resumen", "voz"],
    type: "resumen",
    updatedAt: "2026-01-13",
  },
];

const NOTIFICACIONES_INICIALES = [
  "Alerta: error de grabación por falta de micrófono.",
  "Anomalía detectada en el procesamiento de audio.",
  "Reporte exportado correctamente.",
];

async function archivoABase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function tamanoLegible(bytes) {
  if (!bytes && bytes !== 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(size >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

async function extraerTextoDePdf(file) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    pages.push(`Página ${i}\n${text}`);
  }

  return pages.join("\n\n");
}

async function extraerTextoDeDocx(file) {
  const mammoth = await import("mammoth");
  const buffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
}

async function extraerTextoDeArchivo(file) {
  const name = file.name.toLowerCase();

  if (
    file.type.startsWith("text/") ||
    name.endsWith(".md") ||
    name.endsWith(".csv") ||
    name.endsWith(".json") ||
    name.endsWith(".txt")
  ) {
    return await file.text();
  }

  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return await extraerTextoDePdf(file);
  }

  if (
    file.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) {
    return await extraerTextoDeDocx(file);
  }

  throw new Error("Formato no soportado. Usa TXT, MD, CSV, JSON, PDF o DOCX.");
}

async function llamarGeminiTexto({ apiKey, prompt, extractedText, model }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${prompt}\n\nCONTENIDO A ANALIZAR:\n${extractedText}`,
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini devolvió ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  return (
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") ||
    ""
  );
}

async function llamarGeminiAudio({ apiKey, prompt, audioFile, model }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const base64 = await archivoABase64(audioFile);

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${prompt}\n\nEste input es audio. Primero transcribe y luego analiza.`,
          },
          {
            inlineData: {
              mimeType: audioFile.type || "audio/webm",
              data: base64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini devolvió ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  return (
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") ||
    ""
  );
}

function parsearJsonSeguro(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function Seccion({ title, subtitle, children, right }) {
  return (
    <section className="card">
      <div className="sectionHeader">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p className="muted">{subtitle}</p> : null}
        </div>
        {right ? <div>{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

function TarjetaMetrica({ label, value, hint }) {
  return (
    <div className="metricCard">
      <div className="metricLabel">{label}</div>
      <div className="metricValue">{value}</div>
      <div className="metricHint">{hint}</div>
    </div>
  );
}

function App() {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY || "";
  const model = "gemini-2.5-flash";
  const prompt = PROMPT_MAESTRO;

  const [activeTab, setActiveTab] = useState("captura");

  const [uploadedFile, setUploadedFile] = useState(null);
  const [audioFile, setAudioFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState("");

  const [extractedText, setExtractedText] = useState("");
  const [editedText, setEditedText] = useState("");

  const [resultText, setResultText] = useState("");
  const [resultJson, setResultJson] = useState(null);

  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [isRecording, setIsRecording] = useState(false);

  const [folders, setFolders] = useState([
    "Inbox",
    "Academico",
    "Trabajo",
    "Personal",
  ]);
  const [newFolder, setNewFolder] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [tagInput, setTagInput] = useState("");

  const [selectedRole, setSelectedRole] = useState("free");
  const [loggedIn, setLoggedIn] = useState(false);

  const [mfaEnabled, setMfaEnabled] = useState(true);
  const [semanticSearchEnabled, setSemanticSearchEnabled] = useState(true);
  const [backgroundUploadEnabled, setBackgroundUploadEnabled] = useState(true);
  const [cloudUploadEnabled, setCloudUploadEnabled] = useState(true);

  const [files, setFiles] = useState(ARCHIVOS_INICIALES);
  const [selectedTags, setSelectedTags] = useState(["voz", "ideas"]);
  const [selectedFileId, setSelectedFileId] = useState("f1");
  const [notifications] = useState(NOTIFICACIONES_INICIALES);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const fileInputRef = useRef(null);
  const audioInputRef = useRef(null);
  const contenedorMapaRef = useRef(null);

  const [svgMapaMental, setSvgMapaMental] = useState("");

  const isBusy =
    status === "extracting" ||
    status === "analyzing" ||
    status === "analyzing-audio";

  const metrics = useMemo(
    () => ({
      textLength: editedText.length || extractedText.length,
      summaryParagraphs: resultJson?.executive_summary?.length || 0,
      insights: resultJson?.key_insights?.length || 0,
      tasks: resultJson?.task_list?.length || 0,
      mindNodes: (resultJson?.mind_map_nodes || []).length || 0,
      files: files.length,
    }),
    [editedText, extractedText, resultJson, files]
  );

  const filteredFiles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return files;
    return files.filter((item) => {
      const haystack = `${item.name} ${item.folder} ${(item.tags || []).join(
        " "
      )}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [files, searchQuery]);

  function getStatusLabel() {
    if (status === "extracting") return "Extrayendo texto...";
    if (status === "analyzing") return "Procesando texto...";
    if (status === "analyzing-audio") return "Procesando audio...";
    if (status === "quota-exceeded") return "Cuota agotada";
    if (status === "ready") return "Documento listo";
    if (status === "ready-audio") return "Audio listo";
    if (status === "done") return "Completado";
    if (status === "error") return "Error";
    return "En espera";
  }

  function construirCodigoMermaid() {
    let nodes = resultJson?.mind_map_nodes || [];

    if (!nodes.length && resultJson) {
      const titulo = resultJson.title || "MindVoice";
      const insights = resultJson.key_insights || [];
      const tareas = resultJson.task_list || [];
      const resumen = resultJson.executive_summary || [];

      nodes = [{ id: "raiz", label: titulo, parentId: null }];

      resumen.slice(0, 3).forEach((item, index) => {
        nodes.push({
          id: `resumen_${index + 1}`,
          label: `Resumen ${index + 1}`,
          parentId: "raiz",
        });
        nodes.push({
          id: `resumen_${index + 1}_detalle`,
          label: String(item || "").slice(0, 80),
          parentId: `resumen_${index + 1}`,
        });
      });

      insights.slice(0, 5).forEach((item, index) => {
        nodes.push({
          id: `insight_${index + 1}`,
          label: String(item || "").slice(0, 80),
          parentId: "raiz",
        });
      });

      tareas.slice(0, 5).forEach((item, index) => {
        nodes.push({
          id: `tarea_${index + 1}`,
          label: item?.task ? String(item.task).slice(0, 80) : `Tarea ${index + 1}`,
          parentId: "raiz",
        });
      });
    }

    if (!nodes.length) return "";

    let mermaidCode = "graph TD;\n";

    nodes.forEach((node) => {
      const id = String(node.id || "").replace(/[^a-zA-Z0-9_]/g, "_");
      const parentId = node.parentId
        ? String(node.parentId).replace(/[^a-zA-Z0-9_]/g, "_")
        : null;
      const label = String(node.label || "Nodo").replace(/"/g, '\\"');

      if (parentId) {
        mermaidCode += `${parentId} --> ${id}["${label}"];\n`;
      } else {
        mermaidCode += `${id}["${label}"];\n`;
      }
    });

    return mermaidCode;
  }

  useEffect(() => {
    async function renderizarMapa() {
      const codigo = construirCodigoMermaid();

      if (!codigo) {
        setSvgMapaMental("");
        return;
      }

      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: "default",
          securityLevel: "loose",
        });

        const renderId = `mermaid-map-${Date.now()}`;
        const { svg } = await mermaid.render(renderId, codigo);
        setSvgMapaMental(svg);
      } catch (err) {
        console.error("Error renderizando Mermaid:", err);
        setSvgMapaMental("");
      }
    }

    renderizarMapa();
  }, [resultJson]);

  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadedFile(file);
    setAudioFile(null);
    setAudioUrl("");
    setResultText("");
    setResultJson(null);
    setSvgMapaMental("");
    setError("");
    setStatus("extracting");

    try {
      const text = await extraerTextoDeArchivo(file);
      setExtractedText(text);
      setEditedText(text);
      setStatus("ready");

      setFiles((prev) => [
        {
          id: `file-${Date.now()}`,
          name: file.name,
          folder: "Inbox",
          tags: selectedTags,
          type: "documento",
          updatedAt: new Date().toISOString().slice(0, 10),
        },
        ...prev,
      ]);
    } catch (err) {
      setStatus("error");
      setError(err.message || "No se pudo leer el archivo.");
    }
  }

  function handleAudioSelected(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setAudioFile(file);
    setUploadedFile(null);
    setExtractedText("");
    setEditedText("");
    setResultText("");
    setResultJson(null);
    setSvgMapaMental("");
    setError("");
    setAudioUrl(URL.createObjectURL(file));
    setStatus("ready-audio");

    setFiles((prev) => [
      {
        id: `audio-${Date.now()}`,
        name: file.name,
        folder: "Inbox",
        tags: selectedTags,
        type: "audio",
        updatedAt: new Date().toISOString().slice(0, 10),
      },
      ...prev,
    ]);
  }

  async function startRecording() {
    setError("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const file = new File([blob], `grabacion-${Date.now()}.webm`, {
          type: "audio/webm",
        });

        setAudioFile(file);
        setAudioUrl(URL.createObjectURL(blob));
        setUploadedFile(null);
        setExtractedText("");
        setEditedText("");
        setStatus("ready-audio");

        stream.getTracks().forEach((track) => track.stop());

        setFiles((prev) => [
          {
            id: `rec-${Date.now()}`,
            name: file.name,
            folder: "Inbox",
            tags: selectedTags,
            type: "grabacion",
            updatedAt: new Date().toISOString().slice(0, 10),
          },
          ...prev,
        ]);
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch {
      setError("No se pudo acceder al micrófono. Revisa permisos del navegador.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }

  async function analyzeDocument() {
    if (!apiKey) {
      setError("No se encontró la API key en VITE_GEMINI_API_KEY.");
      return;
    }

    if (!editedText.trim()) {
      setError("Primero sube un archivo o edita el texto.");
      return;
    }

    setError("");
    setStatus("analyzing");

    try {
      const text = await llamarGeminiTexto({
        apiKey,
        prompt,
        extractedText: editedText,
        model,
      });

      setResultText(text);
      setResultJson(parsearJsonSeguro(text));
      setStatus("done");
      setActiveTab("procesamiento");
    } catch (err) {
      const message = err.message || "";

      if (message.includes("429")) {
        setStatus("quota-exceeded");
        setError(
          "Se agotó temporalmente la cuota de Gemini para este modelo. Prueba más tarde o usa otra API key."
        );
      } else {
        setStatus("error");
        setError(message || "No se pudo completar el análisis.");
      }
    }
  }

  async function analyzeAudio() {
    if (!apiKey) {
      setError("No se encontró la API key en VITE_GEMINI_API_KEY.");
      return;
    }

    if (!audioFile) {
      setError("Primero sube o graba un audio.");
      return;
    }

    if (audioFile.size > 10 * 1024 * 1024) {
      setError("El audio es demasiado grande para esta prueba. Usa uno más corto.");
      return;
    }

    setError("");
    setStatus("analyzing-audio");

    try {
      const text = await llamarGeminiAudio({
        apiKey,
        prompt,
        audioFile,
        model,
      });

      setResultText(text);
      const parsed = parsearJsonSeguro(text);
      setResultJson(parsed);
      setEditedText(parsed?.edited_text || parsed?.transcription || "");
      setStatus("done");
      setActiveTab("procesamiento");
    } catch (err) {
      const message = err.message || "";

      if (message.includes("429")) {
        setStatus("quota-exceeded");
        setError(
          "Se agotó temporalmente la cuota de Gemini para este modelo. Prueba más tarde o usa otra API key."
        );
      } else {
        setStatus("error");
        setError(message || "No se pudo procesar el audio.");
      }
    }
  }

  function resetAll() {
    setUploadedFile(null);
    setAudioFile(null);
    setAudioUrl("");
    setExtractedText("");
    setEditedText("");
    setResultText("");
    setResultJson(null);
    setSvgMapaMental("");
    setError("");
    setStatus("idle");

    if (fileInputRef.current) fileInputRef.current.value = "";
    if (audioInputRef.current) audioInputRef.current.value = "";
  }

  function addFolder() {
    const name = newFolder.trim();
    if (!name || folders.includes(name)) return;
    setFolders((prev) => [...prev, name]);
    setNewFolder("");
  }

  function addTag() {
    const name = tagInput.trim();
    if (!name || selectedTags.includes(name)) return;
    setSelectedTags((prev) => [...prev, name]);
    setTagInput("");
  }

  function removeTag(tag) {
    setSelectedTags((prev) => prev.filter((t) => t !== tag));
  }

  function deleteSelectedFile() {
    if (!selectedFileId) return;
    const confirmed = window.confirm(
      "¿Seguro que quieres eliminar este archivo de forma permanente?"
    );
    if (!confirmed) return;

    setFiles((prev) => prev.filter((item) => item.id !== selectedFileId));
    setSelectedFileId("");
  }

  function downloadJson() {
    const content = resultJson
      ? JSON.stringify(resultJson, null, 2)
      : resultText;

    const blob = new Blob([content], {
      type: resultJson ? "application/json" : "text/plain",
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = resultJson ? "mindvoice-analisis.json" : "mindvoice-analisis.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadTxt() {
    const content =
      resultJson?.report_ready_text ||
      editedText ||
      resultText ||
      "Sin contenido exportable.";

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mindvoice-reporte.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadStyledPdf() {
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;
    const maxWidth = pageWidth - margin * 2;
    let y = margin;

    const ensureSpace = (needed = 24) => {
      if (y + needed > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
    };

    const addTitle = (text) => {
      ensureSpace(30);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      doc.text(text, margin, y);
      y += 24;
    };

    const addSection = (title, body) => {
      if (!body || (Array.isArray(body) && body.length === 0)) return;

      ensureSpace(24);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.text(title, margin, y);
      y += 16;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);

      const lines = Array.isArray(body)
        ? body.flatMap((item) => doc.splitTextToSize(`- ${String(item)}`, maxWidth))
        : doc.splitTextToSize(String(body), maxWidth);

      lines.forEach((line) => {
        ensureSpace(14);
        doc.text(line, margin, y);
        y += 14;
      });

      y += 8;
    };

    addTitle(resultJson?.title || "Reporte MindVoice");
    addSection("Resumen ejecutivo", resultJson?.executive_summary || []);
    addSection(
      "Transcripción",
      resultJson?.transcription || editedText || "Sin transcripción."
    );
    addSection(
      "Tareas",
      (resultJson?.task_list || []).map((t) => `${t.task} [${t.priority}]`)
    );
    addSection("Insights", resultJson?.key_insights || []);
    addSection("Etiquetas", resultJson?.tags || selectedTags || []);
    addSection("Palabras clave", resultJson?.semantic_keywords || []);

    doc.save("mindvoice-reporte.pdf");
  }

  function descargarMapaMentalSvg() {
    if (!svgMapaMental) {
      setError("No hay un mapa mental renderizado para descargar.");
      return;
    }

    const blob = new Blob([svgMapaMental], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "mindvoice-mapa-mental.svg";
    a.click();

    URL.revokeObjectURL(url);
  }

  return (
    <div className="appShell">
      <div className="container">
        <header className="hero">
          <div>
            <div className="eyebrow">MindVoice AI</div>
            <h1>Captura de voz, transcripción, análisis con IA y conocimiento estructurado</h1>
            <p className="muted">
              Prototipo alineado al SRS: captura de audio, speech-to-text,
              resúmenes, lista de tareas, mapas mentales, búsqueda semántica,
              gestión de archivos, dashboard, notificaciones, roles y seguridad.
            </p>
          </div>
          <div className="heroStatus">
            <span className={`badge ${status === "error" ? "danger" : ""}`}>
              {getStatusLabel()}
            </span>
            <span className="badge">{selectedRole.toUpperCase()}</span>
            <span className="badge">{loggedIn ? "Sesión JWT" : "Sesión cerrada"}</span>
          </div>
        </header>

        <div className="metricsGrid">
          <TarjetaMetrica label="Texto" value={metrics.textLength.toLocaleString()} hint="caracteres" />
          <TarjetaMetrica label="Resumen ejecutivo" value={metrics.summaryParagraphs} hint="párrafos" />
          <TarjetaMetrica label="Tareas" value={metrics.tasks} hint="RF08" />
          <TarjetaMetrica label="Insights" value={metrics.insights} hint="RF08" />
          <TarjetaMetrica label="Nodos mentales" value={metrics.mindNodes} hint="RF09" />
          <TarjetaMetrica label="Archivos" value={metrics.files} hint="RF10-RF14" />
        </div>

        <nav className="tabsBar">
          <button className={activeTab === "captura" ? "tab active" : "tab"} onClick={() => setActiveTab("captura")}>
            Audio / Captura
          </button>
          <button className={activeTab === "procesamiento" ? "tab active" : "tab"} onClick={() => setActiveTab("procesamiento")}>
            Procesamiento
          </button>
          <button className={activeTab === "archivos" ? "tab active" : "tab"} onClick={() => setActiveTab("archivos")}>
            Gestión de archivos
          </button>
          <button className={activeTab === "dashboard" ? "tab active" : "tab"} onClick={() => setActiveTab("dashboard")}>
            Dashboard web
          </button>
          <button className={activeTab === "usuarios" ? "tab active" : "tab"} onClick={() => setActiveTab("usuarios")}>
            Usuarios / Seguridad
          </button>
        </nav>

        {activeTab === "captura" && (
          <div className="twoCol">
            <Seccion
              title="3.1 Captura y gestión de audio"
              subtitle="RF01 Iniciar grabación · RF02 Detener grabación · RF03 Subida a la nube"
            >
              <div className="dropZone">
                <p>
                  Acciones principales siguiendo el flujo del SRS: iniciar/detener grabación,
                  guardado automático, flujo de subida compatible con MP3/WebM y carga segura en segundo plano.
                </p>
                <div className="buttonRow">
                  <button onClick={() => fileInputRef.current?.click()} disabled={isBusy}>
                    Subir documento
                  </button>
                  <button className="secondary" onClick={() => audioInputRef.current?.click()} disabled={isBusy}>
                    Subir audio
                  </button>
                  {!isRecording ? (
                    <button onClick={startRecording} disabled={isBusy}>
                      Iniciar grabación
                    </button>
                  ) : (
                    <button className="danger" onClick={stopRecording}>
                      Detener grabación
                    </button>
                  )}
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,.csv,.json,.pdf,.docx"
                  onChange={handleFileChange}
                  style={{ display: "none" }}
                />
                <input
                  ref={audioInputRef}
                  type="file"
                  accept="audio/*"
                  onChange={handleAudioSelected}
                  style={{ display: "none" }}
                />
              </div>

              {uploadedFile && (
                <div className="infoCard">
                  <strong>Documento cargado:</strong> {uploadedFile.name}
                  <div className="muted">{tamanoLegible(uploadedFile.size)}</div>
                </div>
              )}

              {audioFile && (
                <div className="infoCard">
                  <strong>Audio cargado:</strong> {audioFile.name}
                  <div className="muted">
                    {tamanoLegible(audioFile.size)} · subida segura a nube{" "}
                    {cloudUploadEnabled ? "ACTIVADA" : "DESACTIVADA"}
                  </div>
                </div>
              )}

              {audioUrl && (
                <div className="audioBox">
                  <audio controls src={audioUrl} style={{ width: "100%" }} />
                </div>
              )}

              <div className="switchGrid">
                <label className="switchItem">
                  <input
                    type="checkbox"
                    checked={backgroundUploadEnabled}
                    onChange={(e) => setBackgroundUploadEnabled(e.target.checked)}
                  />
                  Subida en segundo plano
                </label>
                <label className="switchItem">
                  <input
                    type="checkbox"
                    checked={cloudUploadEnabled}
                    onChange={(e) => setCloudUploadEnabled(e.target.checked)}
                  />
                  Almacenamiento seguro en la nube
                </label>
              </div>
            </Seccion>

            <Seccion
              title="3.2 Conversión y procesamiento"
              subtitle="RF04 Speech-to-text · RF05 Edición de texto · RF06 Analítica IA · RF07 RF08 RF09"
              right={<span className="badge">{getStatusLabel()}</span>}
            >
              <textarea
                className="bigTextarea"
                value={editedText}
                onChange={(e) => setEditedText(e.target.value)}
                placeholder="Panel de transcripción / texto editable para correcciones antes del análisis IA..."
                disabled={isBusy}
              />

              <div className="buttonRow">
                <button onClick={analyzeDocument} disabled={isBusy}>
                  {status === "analyzing" ? "Procesando texto..." : "Analizar texto"}
                </button>
                <button className="secondary" onClick={analyzeAudio} disabled={isBusy}>
                  {status === "analyzing-audio" ? "Procesando audio..." : "Speech-to-text + IA"}
                </button>
                <button className="secondary" onClick={resetAll} disabled={isBusy}>
                  Reiniciar
                </button>
              </div>

              <div className="hintBox">
                <strong>Prompt Maestro:</strong> estandarización interna en JSON para resúmenes,
                lista de tareas, timestamps y nodos de mapa mental.
              </div>
            </Seccion>
          </div>
        )}

        {activeTab === "procesamiento" && (
          <div className="twoCol">
            <Seccion
              title="Salida JSON de IA"
              subtitle="Resultados estructurados listos para exportar, consultar y renderizar"
            >
              <pre className="resultBox">
                {resultJson
                  ? JSON.stringify(resultJson, null, 2)
                  : resultText || "Aún no hay análisis."}
              </pre>
            </Seccion>

            <Seccion
              title="Vista ejecutiva"
              subtitle="Resumen en 3 párrafos, insights, tareas y mapa mental renderizado"
            >
              <div className="infoCard">
                <strong>Título</strong>
                <p>{resultJson?.title || "-"}</p>
              </div>

              <div className="infoCard">
                <strong>Resumen ejecutivo (3 párrafos)</strong>
                {(resultJson?.executive_summary || []).length ? (
                  resultJson.executive_summary.map((p, idx) => <p key={idx}>{p}</p>)
                ) : (
                  <p>-</p>
                )}
              </div>

              <div className="infoCard">
                <strong>Tareas</strong>
                <ul>
                  {(resultJson?.task_list || []).length ? (
                    resultJson.task_list.map((item, idx) => (
                      <li key={idx}>
                        {item.task} <span className="muted">[{item.priority}]</span>
                      </li>
                    ))
                  ) : (
                    <li>-</li>
                  )}
                </ul>
              </div>

              <div className="infoCard">
                <strong>Insights clave</strong>
                <ul>
                  {(resultJson?.key_insights || []).length ? (
                    resultJson.key_insights.map((item, idx) => <li key={idx}>{item}</li>)
                  ) : (
                    <li>-</li>
                  )}
                </ul>
              </div>

              <div className="infoCard">
                <strong>Mapa mental generado</strong>
                {svgMapaMental ? (
                  <div
                    ref={contenedorMapaRef}
                    className="mapaMentalRender"
                    dangerouslySetInnerHTML={{ __html: svgMapaMental }}
                  />
                ) : (
                  <p className="muted">
                    Aún no se pudo renderizar el mapa mental. Si Gemini no devuelve
                    <code> mind_map_nodes </code>, la app intentará construir uno automático
                    usando título, resumen, insights y tareas.
                  </p>
                )}
              </div>

              <div className="infoCard">
                <strong>Código Mermaid generado</strong>
                <pre className="miniCode">
                  {construirCodigoMermaid() || "No se generó código."}
                </pre>
              </div>

              <div className="infoCard">
                <strong>Timestamps de speech-to-text en JSON</strong>
                <pre className="miniCode">
                  {resultJson?.transcription_with_timestamps
                    ? JSON.stringify(resultJson.transcription_with_timestamps, null, 2)
                    : "Las frases con timestamps aparecerán aquí cuando el modelo las devuelva."}
                </pre>
              </div>

              <div className="buttonRow">
                <button className="secondary" onClick={downloadJson} disabled={!resultText}>
                  Exportar JSON
                </button>
                <button className="secondary" onClick={downloadTxt} disabled={!resultText}>
                  Exportar TXT
                </button>
                <button onClick={downloadStyledPdf} disabled={!resultText}>
                  Exportar PDF
                </button>
                <button className="secondary" onClick={descargarMapaMentalSvg} disabled={!svgMapaMental}>
                  Descargar mapa mental SVG
                </button>
              </div>
            </Seccion>
          </div>
        )}

        {activeTab === "archivos" && (
          <div className="twoCol">
            <Seccion
              title="3.3 Gestión de notas y archivos"
              subtitle="RF10 organización · RF11 etiquetas · RF12 búsqueda semántica · RF13 eliminar · RF14 exportar"
            >
              <div className="formBlock">
                <label>Nueva carpeta / subcarpeta</label>
                <div className="inlineForm">
                  <input
                    value={newFolder}
                    onChange={(e) => setNewFolder(e.target.value)}
                    placeholder="Ejemplo: Trabajo/Clientes/Reuniones"
                  />
                  <button onClick={addFolder}>Agregar</button>
                </div>
              </div>

              <div className="formBlock">
                <label>Etiquetado de contenido</label>
                <div className="inlineForm">
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    placeholder="Agregar etiqueta"
                  />
                  <button className="secondary" onClick={addTag}>
                    Agregar etiqueta
                  </button>
                </div>
                <div className="chips">
                  {selectedTags.map((tag) => (
                    <span key={tag} className="chip" onClick={() => removeTag(tag)}>
                      {tag} ×
                    </span>
                  ))}
                </div>
              </div>

              <div className="formBlock">
                <label>Consulta y búsqueda</label>
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={
                    semanticSearchEnabled
                      ? "Buscar por palabras clave y conceptos (búsqueda semántica)"
                      : "Búsqueda por palabra clave"
                  }
                />
                <div className="muted topSpace">
                  Placeholder de similarity search: {semanticSearchEnabled ? "activado" : "desactivado"}
                </div>
              </div>

              <div className="formBlock">
                <label>Carpetas disponibles</label>
                <div className="chips">
                  {folders.map((folder) => (
                    <span key={folder} className="chip secondaryChip">
                      {folder}
                    </span>
                  ))}
                </div>
              </div>

              <div className="formBlock">
                <label>Eliminar archivo permanentemente</label>
                <select
                  value={selectedFileId}
                  onChange={(e) => setSelectedFileId(e.target.value)}
                >
                  <option value="">Selecciona archivo</option>
                  {files.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <div className="buttonRow">
                  <button className="secondary">Editar metadatos</button>
                  <button className="danger" onClick={deleteSelectedFile}>
                    Eliminar permanentemente
                  </button>
                </div>
              </div>
            </Seccion>

            <Seccion
              title="Panel de archivos web / móvil"
              subtitle="Panel principal de archivos, carpetas, etiquetas y filtros"
            >
              <div className="listScroll">
                {filteredFiles.length ? (
                  filteredFiles.map((item) => (
                    <div key={item.id} className="libraryItem">
                      <div>
                        <div className="libraryTitle">{item.name}</div>
                        <div className="muted">
                          {item.folder} · {item.updatedAt}
                        </div>
                        <div className="chips">
                          {(item.tags || []).map((tag) => (
                            <span key={tag} className="chip secondaryChip">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                      <span className="badge">{item.type}</span>
                    </div>
                  ))
                ) : (
                  <p className="muted">No se encontraron resultados.</p>
                )}
              </div>
            </Seccion>
          </div>
        )}

        {activeTab === "dashboard" && (
          <div className="twoCol">
            <Seccion
              title="4.1 Interfaces de usuario / Dashboard web"
              subtitle="Dashboard responsive, búsqueda avanzada, archivos, carpetas, etiquetas, notificaciones y mapa mental"
            >
              <div className="metricsGrid small">
                <TarjetaMetrica label="Respuesta dashboard" value="< 2s" hint="Objetivo RNF01" />
                <TarjetaMetrica label="Procesamiento de audio" value="< 60s" hint="Objetivo RNF03" />
                <TarjetaMetrica label="Sincronización cloud" value={cloudUploadEnabled ? "ACTIVA" : "OFF"} hint="HTTPS" />
                <TarjetaMetrica label="Búsqueda semántica" value={semanticSearchEnabled ? "ACTIVA" : "OFF"} hint="RF12" />
              </div>

              <div className="infoCard">
                <strong>Visualización de mapa mental (compatible con Mermaid.js)</strong>
                <pre className="miniCode">{`graph TD;
Conversacion --> Resumen;
Conversacion --> Tareas;
Conversacion --> Insights;
Insights --> NodoA;`}</pre>
              </div>

              <div className="infoCard">
                <strong>Notificaciones</strong>
                <ul>
                  {notifications.map((note, idx) => (
                    <li key={idx}>{note}</li>
                  ))}
                </ul>
                <p className="muted topSpace">
                  Persistentes, claras y con mensajes concisos, como pide el SRS.
                </p>
              </div>
            </Seccion>

            <Seccion
              title="5. Requisitos no funcionales"
              subtitle="Rendimiento, seguridad y atributos de calidad"
            >
              <div className="checkList">
                <label><input type="checkbox" checked readOnly /> RNF01 objetivo de tiempo de respuesta visible</label>
                <label><input type="checkbox" checked readOnly /> RNF02 capacidad concurrente representada en notas de arquitectura</label>
                <label><input type="checkbox" checked readOnly /> RNF03 meta de procesamiento de audio visible</label>
                <label><input type="checkbox" checked={mfaEnabled} readOnly /> RNF04 JWT + MFA visible en la UI</label>
                <label><input type="checkbox" checked readOnly /> RNF05 cifrado en tránsito y reposo documentado</label>
                <label><input type="checkbox" checked readOnly /> RNF07 interfaz intuitiva</label>
                <label><input type="checkbox" checked readOnly /> RNF08 intención de accesibilidad</label>
                <label><input type="checkbox" checked readOnly /> RNF09 consistencia visual</label>
              </div>

              <div className="infoCard">
                <strong>Interfaces externas representadas</strong>
                <p>
                  Micrófonos móviles, almacenamiento tipo AWS S3, backend REST,
                  PostgreSQL/Mongo, comunicación HTTPS, visualización compatible
                  con Angular/Mermaid y consumo seguro de APIs externas de IA.
                </p>
              </div>
            </Seccion>
          </div>
        )}

        {activeTab === "usuarios" && (
          <div className="twoCol">
            <Seccion
              title="3.4 Gestión de usuarios y seguridad"
              subtitle="RF15 registro · RF16 login · RF17 modificación de perfil · RF18 logout · RF19 control de roles"
            >
              <div className="formBlock">
                <label>Rol de usuario</label>
                <select
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value)}
                >
                  <option value="free">Free</option>
                  <option value="pro">Pro</option>
                  <option value="business">Business</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              <div className="grid2">
                <div className="formBlock">
                  <label>Correo electrónico</label>
                  <input placeholder="usuario@mindvoice.ai" />
                </div>
                <div className="formBlock">
                  <label>Contraseña</label>
                  <input type="password" placeholder="********" />
                </div>
              </div>

              <div className="buttonRow">
                <button onClick={() => setLoggedIn(true)}>Iniciar sesión</button>
                <button className="secondary">Registrar usuario</button>
                <button className="secondary">Modificar perfil</button>
                <button className="danger" onClick={() => setLoggedIn(false)}>
                  Cerrar sesión
                </button>
              </div>

              <div className="switchGrid">
                <label className="switchItem">
                  <input
                    type="checkbox"
                    checked={mfaEnabled}
                    onChange={(e) => setMfaEnabled(e.target.checked)}
                  />
                  Autenticación multifactor
                </label>
                <label className="switchItem">
                  <input
                    type="checkbox"
                    checked={semanticSearchEnabled}
                    onChange={(e) => setSemanticSearchEnabled(e.target.checked)}
                  />
                  Permiso de búsqueda semántica
                </label>
              </div>

              <div className="infoCard">
                <strong>Autenticación</strong>
                <p>
                  UI lista para email/password. La autenticación JWT y la auditoría
                  quedan representadas como placeholders, tal como pide el SRS.
                </p>
              </div>
            </Seccion>

            <Seccion
              title="RF19 Control de roles"
              subtitle="Acciones limitadas según el rol asignado"
            >
              <div className="roleCard">
                <strong>Free</strong>
                <p>Solo lectura / consulta básica.</p>
              </div>
              <div className="roleCard">
                <strong>Pro</strong>
                <p>Edición parcial, transcripciones, resúmenes, tareas, etiquetas y carpetas.</p>
              </div>
              <div className="roleCard">
                <strong>Business</strong>
                <p>Funciones completas, exportaciones, dashboard, búsqueda semántica y gestión.</p>
              </div>
              <div className="roleCard">
                <strong>Admin</strong>
                <p>Administración de usuarios, asignación de roles y control operativo.</p>
              </div>
            </Seccion>
          </div>
        )}

        {error && <div className="errorBanner">Error: {error}</div>}
      </div>
    </div>
  );
}

export default App;