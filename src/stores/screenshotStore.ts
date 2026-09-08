import { create } from "zustand";
import { captureScreen, analyzeScreenshotBatch, getAssembledContext } from "../lib/ipc";
import { useConfigStore } from "./configStore";
import { useTranscriptStore } from "./transcriptStore";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export interface QueuedScreenshot {
  id: string;
  data: string;
  createdAt: number;
}

interface ScreenshotState {
  images: QueuedScreenshot[];
  isCapturing: boolean;
  isSending: boolean;
  error: string | null;
  capture: () => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
  send: () => Promise<void>;
}

function recentTranscript(): string {
  const seconds = useConfigStore.getState().contextWindowSeconds;
  const segments = useTranscriptStore.getState().segments.filter((s) => s.is_final);
  const cutoff = seconds > 0 ? Date.now() - seconds * 1000 : 0;
  return segments
    .filter((s) => !cutoff || s.timestamp_ms >= cutoff)
    .map((s) => `[${s.speaker}] ${s.text}`)
    .join("\n");
}

export const useScreenshotStore = create<ScreenshotState>((set, get) => ({
  images: [], isCapturing: false, isSending: false, error: null,
  capture: async () => {
    if (get().isCapturing || get().isSending) return;
    set({ isCapturing: true, error: null });
    let overlayWasVisible = false;
    let overlay: Awaited<ReturnType<typeof getCurrentWebviewWindow>> | null = null;
    try {
      // Hide the overlay for one compositor frame so the native desktop capture
      // cannot include the assistant UI in the screenshot.
      overlay = getCurrentWebviewWindow();
      if (overlay.label === "overlay") {
        overlayWasVisible = await overlay.isVisible().catch(() => false);
        if (overlayWasVisible) {
          await overlay.hide();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const data = await captureScreen();
      if (data.length > 12_000_000) throw new Error("Screenshot is too large");
      set((state) => ({ images: [...state.images, { id: crypto.randomUUID(), data, createdAt: Date.now() }] }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      if (overlay && overlay.label === "overlay" && overlayWasVisible) {
        await overlay.show().catch(() => {});
      }
      set({ isCapturing: false });
    }
  },
  remove: (id) => set((state) => ({ images: state.images.filter((image) => image.id !== id) })),
  clear: () => set({ images: [], error: null }),
  send: async () => {
    const state = get();
    const config = useConfigStore.getState();
    if (!state.images.length) throw new Error("No screenshots queued");
    if (!config.visionModel) throw new Error("Select a vision model in Settings");
    set({ isSending: true, error: null });
    try {
      const context = await getAssembledContext().catch(() => "");
      const transcript = [recentTranscript(), context ? `Reference context:\n${context}` : ""]
        .filter(Boolean).join("\n\n");
      await analyzeScreenshotBatch(
        state.images.map((image) => ({ media_type: "image/png", data: image.data })),
        transcript, config.visionProvider, config.visionModel,
      );
      set({ images: [] });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { set({ isSending: false }); }
  },
}));
