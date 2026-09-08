// Runs meeting-critical hooks at the App level so they persist
// even when the user navigates away from the overlay view.
// This ensures transcription, timers, and persistence continue
// in the background regardless of which page is displayed.
//
// Two-window architecture: launcher window handles persistence/audio control;
// overlay window subscribes to events for display only.

import { useMeetingStore } from "../stores/meetingStore";
import { useMeetingTimer } from "../hooks/useMeetingTimer";
import { useTranscriptPersistence } from "../hooks/useTranscriptPersistence";
import { useTranscript } from "../hooks/useTranscript";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { useAudioConfigSync } from "../hooks/useAudioConfigSync";
import { useStreamBuffer } from "../hooks/useStreamBuffer";
import { useCallLogCapture } from "../hooks/useCallLogCapture";
import { useSTTStatus } from "../hooks/useSTTStatus";
import { useDevLog } from "../hooks/useDevLog";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useScreenshotStore } from "../stores/screenshotStore";
import { useConfigStore } from "../stores/configStore";

export function ActiveMeetingProvider({ isLauncherWindow = true }: { isLauncherWindow?: boolean }) {
  const activeMeeting = useMeetingStore((s) => s.activeMeeting);

  if (!activeMeeting) return null;

  // Overlay window: subscribe to events for display (no persistence, no audio control)
  if (!isLauncherWindow) return <OverlayMeetingHooks />;

  return <LauncherMeetingHooks />;
}

// Overlay window: display-only hooks — populate local Zustand stores from Tauri events
function OverlayMeetingHooks() {
  useMeetingTimer();
  useTranscript();    // transcript_final/update → local store
  useStreamBuffer();  // AI streaming events → local store
  useSTTStatus();     // STT connection status
  useDevLog();        // debug log entries
  useEffect(() => {
    let unlistenCapture: (() => void) | undefined;
    let unlistenSend: (() => void) | undefined;
    listen("nexq:capture_screenshot", () => {
      useScreenshotStore.getState().capture().catch(() => {});
    }).then((fn) => { unlistenCapture = fn; });
    listen("nexq:send_screenshot_batch", () => {
      useScreenshotStore.getState().send().catch(() => {});
    }).then((fn) => { unlistenSend = fn; });
    let unlistenMouse: (() => void) | undefined;
    listen<number>("nexq:mouse_button", (event) => {
      const configured = useConfigStore.getState().hotkeys.capture_screenshot;
      if (configured === `Mouse${event.payload}`) useScreenshotStore.getState().capture().catch(() => {});
    }).then((fn) => { unlistenMouse = fn; });
    return () => {
      unlistenCapture?.(); unlistenSend?.(); unlistenMouse?.();
      useScreenshotStore.getState().clear();
    };
  }, []);
  return null;
}

// Launcher window: persistence + audio control (hidden during meeting)
function LauncherMeetingHooks() {
  useMeetingTimer();
  useTranscript();         // also subscribe here so persistence hook sees segments
  useSpeechRecognition();  // web speech API (emits cross-window events for overlay)
  useAudioConfigSync();    // hot-swap STT/audio config
  useTranscriptPersistence(); // transcript store → SQLite DB
  useStreamBuffer();
  useCallLogCapture();
  useSTTStatus();
  useDevLog();
  return null;
}
