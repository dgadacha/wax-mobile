// Haptics helper. Wraps @capacitor/haptics on native, falls back to the
// Vibration API on the web (silent on browsers without it). Every call is
// fire-and-forget — failures are swallowed.
//
// Use the named helpers (light / medium / heavy / selection / success /
// warning / error) at the call site instead of importing the Capacitor
// types directly, so the same call works on iOS / Android / web.
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

function vibe(ms) {
  try { navigator.vibrate?.(ms); } catch {}
}

async function impact(style) {
  try { await Haptics.impact({ style }); }
  catch { vibe(style === ImpactStyle.Heavy ? 30 : style === ImpactStyle.Medium ? 15 : 8); }
}

async function notify(type) {
  try { await Haptics.notification({ type }); }
  catch { vibe(type === NotificationType.Error ? [10, 50, 10] : 20); }
}

export const haptics = {
  light:     () => impact(ImpactStyle.Light),
  medium:    () => impact(ImpactStyle.Medium),
  heavy:     () => impact(ImpactStyle.Heavy),
  selection: () => Haptics.selectionStart().catch(() => vibe(5)),
  success:   () => notify(NotificationType.Success),
  warning:   () => notify(NotificationType.Warning),
  error:     () => notify(NotificationType.Error),
};
