use crate::llm::provider::{
    GenerationParams, LLMImage, LLMMessage, RagChunkInfo, StreamStartPayload,
};
use crate::llm::{LLMRouter, ProviderConfig};
use crate::state::AppState;
use base64::Engine;
use std::sync::OnceLock;
use tauri::{command, AppHandle, Emitter, State};

static MOUSE_APP: OnceLock<AppHandle> = OnceLock::new();

#[cfg(target_os = "windows")]
unsafe extern "system" fn low_level_mouse_proc(
    code: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::Input::KeyboardAndMouse::{MSLLHOOKSTRUCT, WM_XBUTTONDOWN};
    use windows::Win32::UI::WindowsAndMessaging::CallNextHookEx;
    if code >= 0 && wparam.0 == WM_XBUTTONDOWN as usize {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let button = ((info.mouseData >> 16) & 0xffff) as u32;
        if button == 1 || button == 2 {
            if let Some(app) = MOUSE_APP.get() {
                let _ = app.emit("nexq:mouse_button", button + 3);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

pub fn start_mouse_hook(app: AppHandle) {
    if MOUSE_APP.set(app).is_err() {
        return;
    }
    #[cfg(target_os = "windows")]
    std::thread::spawn(|| unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, WH_MOUSE_LL,
        };
        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(low_level_mouse_proc), None, 0) {
            Ok(hook) => hook,
            Err(error) => {
                log::warn!("Failed to install global mouse hook: {}", error);
                return;
            }
        };
        let mut message = windows::Win32::UI::WindowsAndMessaging::MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let _ = windows::Win32::UI::WindowsAndMessaging::UnhookWindowsHookEx(hook);
    });
}

/// Captures the Windows virtual desktop as a PNG. The overlay is excluded by
/// the existing display-affinity/stealth setting when enabled.
#[command]
pub async fn capture_screen() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use image::{ImageBuffer, Rgba};
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Gdi::*;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
            SM_YVIRTUALSCREEN,
        };

        unsafe {
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if width <= 0 || height <= 0 {
                return Err("No capturable display was found".to_string());
            }

            let screen_dc = GetDC(HWND(0));
            if screen_dc.0 == 0 {
                return Err("Failed to acquire screen device context".to_string());
            }
            let memory_dc = CreateCompatibleDC(screen_dc);
            let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
            if memory_dc.0 == 0 || bitmap.0 == 0 {
                if bitmap.0 != 0 {
                    let _ = DeleteObject(bitmap);
                }
                if memory_dc.0 != 0 {
                    let _ = DeleteDC(memory_dc);
                }
                ReleaseDC(HWND(0), screen_dc);
                return Err("Failed to allocate screenshot buffer".to_string());
            }
            let previous = SelectObject(memory_dc, bitmap);
            let copied = BitBlt(memory_dc, 0, 0, width, height, screen_dc, x, y, SRCCOPY).as_bool();
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
            let read = if copied {
                GetDIBits(
                    memory_dc,
                    bitmap,
                    0,
                    height as u32,
                    Some(pixels.as_mut_ptr() as *mut _),
                    &mut info,
                    DIB_RGB_COLORS,
                )
            } else {
                0
            };
            SelectObject(memory_dc, previous);
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(memory_dc);
            ReleaseDC(HWND(0), screen_dc);
            if read == 0 {
                return Err("Failed to read screenshot pixels".to_string());
            }

            for pixel in pixels.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
            let image = ImageBuffer::<Rgba<u8>, _>::from_raw(width as u32, height as u32, pixels)
                .ok_or_else(|| "Failed to create screenshot image".to_string())?;
            let mut png = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(image)
                .write_to(&mut png, image::ImageFormat::Png)
                .map_err(|e| format!("Failed to encode screenshot: {}", e))?;
            return Ok(base64::engine::general_purpose::STANDARD.encode(png.into_inner()));
        }
    }

    #[cfg(not(target_os = "windows"))]
    Err("Screen capture is currently supported on Windows only".to_string())
}

#[command]
pub async fn analyze_screenshot_batch(
    images: String,
    transcript: String,
    vision_provider: String,
    vision_model: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if vision_model.trim().is_empty() {
        return Err("Select a vision model first".to_string());
    }
    let raw_images: Vec<LLMImage> =
        serde_json::from_str(&images).map_err(|e| format!("Invalid screenshot batch: {}", e))?;
    if raw_images.is_empty() {
        return Err("No screenshots queued".to_string());
    }
    if raw_images.len() > 8 {
        return Err("A maximum of 8 screenshots can be sent at once".to_string());
    }

    let api_key = state
        .credentials
        .as_ref()
        .and_then(|c| c.lock().ok())
        .and_then(|c| c.get_key(&vision_provider).ok().flatten());
    let provider_type =
        crate::llm::ProviderType::from_str(&vision_provider).map_err(|e| e.to_string())?;
    let config = ProviderConfig {
        provider_type: vision_provider.clone(),
        api_key,
        base_url: Some(provider_type.default_base_url().to_string()),
        auth_type: None,
        auth_value: None,
        auth_header: None,
    };
    let mut router = LLMRouter::new();
    router
        .set_provider(config)
        .map_err(|e| format!("Vision provider unavailable: {}", e))?;
    router.set_active_model(vision_model.clone());
    let provider = router.get_provider().map_err(|e| e.to_string())?;
    let prompt = format!(
        "Analyze these screenshots in the context of a live technical interview. Explain the relevant code, UI, error, or problem visible in the images and suggest a concise, technically accurate response for the interview.\n\nRecent interview transcript:\n{}",
        if transcript.trim().is_empty() { "(no transcript available)" } else { &transcript }
    );
    let _ = app_handle.emit(
        "llm_stream_start",
        StreamStartPayload {
            mode: "VisionAnalysis".to_string(),
            model: vision_model,
            provider: vision_provider,
            system_prompt: "You are a real-time technical interview vision copilot.".to_string(),
            user_prompt: prompt.clone(),
            include_transcript: true,
            include_rag: false,
            include_instructions: true,
            include_question: false,
            temperature: 0.2,
            rag_query: None,
            rag_chunks: Vec::<RagChunkInfo>::new(),
            rag_chunks_filtered: 0,
            rag_total_candidates: 0,
            transcript_window_seconds: 0,
            transcript_segments_count: 0,
            transcript_segments_total: 0,
        },
    );
    let result = provider
        .lock()
        .await
        .stream_completion(
            vec![LLMMessage {
                role: "user".to_string(),
                content: prompt,
                images: raw_images,
            }],
            &router.active_model().to_string(),
            GenerationParams {
                temperature: Some(0.2),
                ..Default::default()
            },
            app_handle,
        )
        .await;
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[command]
pub async fn list_vision_models(provider: String) -> Result<String, String> {
    let config: ProviderConfig = serde_json::from_str(&provider)
        .map_err(|e| format!("Invalid vision provider config: {}", e))?;
    let mut router = LLMRouter::new();
    router.set_provider(config).map_err(|e| e.to_string())?;
    let provider = router.get_provider().map_err(|e| e.to_string())?;
    let models = provider
        .lock()
        .await
        .list_models()
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&models).map_err(|e| e.to_string())
}
