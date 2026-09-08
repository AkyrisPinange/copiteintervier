import { useEffect, useState } from "react";
import { useConfigStore } from "../stores/configStore";
import { getApiKey, listVisionModels, listOpenRouterModels, storeApiKey } from "../lib/ipc";
import type { LLMProviderType, ModelInfo, OpenRouterModel } from "../lib/types";
import { Camera, RefreshCw } from "lucide-react";

const PROVIDERS: Array<{ id: LLMProviderType; label: string }> = [
  { id: "openai", label: "OpenAI" }, { id: "anthropic", label: "Anthropic" },
  { id: "groq", label: "Groq" },
  { id: "gemini", label: "Google Gemini" }, { id: "openrouter", label: "OpenRouter" },
  { id: "ollama", label: "Ollama" }, { id: "lm_studio", label: "LM Studio" },
];

function visionModels(models: ModelInfo[]) {
  return models.filter((m) => {
    const value = `${m.id} ${m.name}`;
    if (/tts|transcribe|live|embedding|moderation|image|imagen|veo|audio/i.test(value)) return false;
    return /vision|image|gpt-4o|gpt-4\.1|claude|gemini|llama-4|qwen3\.(6|vl)|llava|qwen2\.5-vl|qwen-vl|pixtral|ministral-3/i.test(value);
  });
}

export function VisionSettings() {
  const provider = useConfigStore((s) => s.visionProvider);
  const model = useConfigStore((s) => s.visionModel);
  const setProvider = useConfigStore((s) => s.setVisionProvider);
  const setModel = useConfigStore((s) => s.setVisionModel);
  const [selectedProvider, setSelectedProvider] = useState(provider);
  const [selectedModel, setSelectedModel] = useState(model);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => { getApiKey(selectedProvider).then((key) => setApiKey(key || "")).catch(() => setApiKey("")); }, [selectedProvider]);

  const load = async () => {
    setLoading(true);
    try {
      if (apiKey) await storeApiKey(selectedProvider, apiKey);
      const config = JSON.stringify({ provider_type: selectedProvider, ...(apiKey ? { api_key: apiKey } : {}) });
      if (selectedProvider === "openrouter") {
        const result = await listOpenRouterModels(true);
        setOpenRouterModels(result.filter((m) => m.input_modalities?.includes("image")));
      } else {
        setModels(visionModels(await listVisionModels(config)));
      }
    } finally { setLoading(false); }
  };

  const selectProvider = (next: LLMProviderType) => { setSelectedProvider(next); setSelectedModel(""); setModels([]); setOpenRouterModels([]); };
  const selectModel = (next: string) => { setSelectedModel(next); setProvider(selectedProvider); setModel(next); };
  const available = selectedProvider === "openrouter" ? openRouterModels.map((m) => ({ id: m.id, name: m.name })) : models;

  return <div className="space-y-6">
    <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-5 py-3.5">
      <Camera className="h-4 w-4 text-primary" />
      <div><p className="text-sm font-medium">Vision: {provider} {model ? `/ ${model}` : ""}</p><p className="text-xs text-muted-foreground">Choose the model used for screenshot analysis.</p></div>
    </div>
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <h3 className="mb-3 text-sm font-semibold text-primary/80">Vision Provider</h3>
      <div className="grid grid-cols-3 gap-2">{PROVIDERS.map((item) => <button key={item.id} onClick={() => selectProvider(item.id)} className={`rounded-lg border p-2.5 text-left text-xs ${selectedProvider === item.id ? "border-primary bg-primary/10 text-primary" : "border-border/50 hover:bg-accent/50"}`}>{item.label}</button>)}</div>
      {!["ollama", "lm_studio"].includes(selectedProvider) && <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} onBlur={() => apiKey && storeApiKey(selectedProvider, apiKey)} placeholder="API key" className="mt-4 w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm" />}
    </div>
    <div className="rounded-xl border border-border/30 bg-card/50 p-5">
      <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold text-primary/80">Vision Model</h3><button onClick={load} disabled={loading} className="rounded-md p-2 text-muted-foreground hover:bg-accent" aria-label="Load vision models" title="Load vision models"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /></button></div>
      <select value={selectedModel} onChange={(e) => selectModel(e.target.value)} className="w-full rounded-lg border border-border/50 bg-background px-3 py-2.5 text-sm"><option value="">Select a vision model...</option>{available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <p className="mt-2 text-xs text-muted-foreground">Load models to show only candidates with image support.</p>
    </div>
  </div>;
}
