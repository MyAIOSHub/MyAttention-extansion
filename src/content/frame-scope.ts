export interface FrameLikeWindow {
  self: unknown;
  top: unknown;
}

export function isTopLevelFrame(frameWindow: FrameLikeWindow = window): boolean {
  try {
    return frameWindow.self === frameWindow.top;
  } catch {
    return false;
  }
}
