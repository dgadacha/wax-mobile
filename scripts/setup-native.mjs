#!/usr/bin/env node
// Idempotent patches for the freshly-generated ios/ and android/ folders.
// Run after `npx cap add ios` / `npx cap add android` — or via
// `npm run cap:setup` after a sync — to wire:
//   - iOS background audio (Info.plist UIBackgroundModes + AVAudioSession
//     in AppDelegate.swift + beginReceivingRemoteControlEvents)
//   - Android background audio permissions (WAKE_LOCK + FOREGROUND_SERVICE
//     + FOREGROUND_SERVICE_MEDIA_PLAYBACK)
//
// Safe to run multiple times: every patch checks for its sentinel before
// inserting.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function patchFile(file, label, contains, transform) {
  if (!fs.existsSync(file)) {
    console.log(`[skip] ${label}: ${path.relative(ROOT, file)} not found`);
    return false;
  }
  const before = fs.readFileSync(file, 'utf8');
  if (before.includes(contains)) {
    console.log(`[ok]   ${label}: already patched`);
    return false;
  }
  const after = transform(before);
  if (after === before) {
    console.log(`[warn] ${label}: transform produced no change`);
    return false;
  }
  fs.writeFileSync(file, after);
  console.log(`[done] ${label}: patched ${path.relative(ROOT, file)}`);
  return true;
}

// ── iOS ─────────────────────────────────────────────────────────────
patchFile(
  path.join(ROOT, 'ios/App/App/Info.plist'),
  'iOS UIBackgroundModes',
  '<key>UIBackgroundModes</key>',
  (s) => s.replace(
    /<key>UIViewControllerBasedStatusBarAppearance<\/key>\s*<true\/>\s*<\/dict>/,
    `<key>UIViewControllerBasedStatusBarAppearance</key>
\t<true/>
\t<!-- Background audio: required so the WebView's <audio> keeps playing
\t     when the user locks the device or backgrounds the app. -->
\t<key>UIBackgroundModes</key>
\t<array>
\t\t<string>audio</string>
\t</array>
</dict>`,
  ),
);

patchFile(
  path.join(ROOT, 'ios/App/App/AppDelegate.swift'),
  'iOS AppDelegate AVAudioSession',
  // Sentinel kept short + stable: any future tweak to the patch body
  // still leaves this string present, so re-runs become no-ops.
  'session.setCategory(.playback',
  (s) => s
    // Only add the imports if AVFoundation isn't already there.
    .replace(
      /^import Capacitor$/m,
      (match) => s.includes('import AVFoundation')
        ? match
        : `import Capacitor
import AVFoundation
import MediaPlayer`,
    )
    .replace(
      /(func application\(_ application: UIApplication, didFinishLaunchingWithOptions[^{]+\{)\s*\/\/[^\n]*\n\s*return true/,
      `$1
        // Background audio session: must be set to \`.playback\` for iOS to
        // keep the WebView's HTML5 <audio> alive when the device locks or
        // the app backgrounds. Pairs with UIBackgroundModes = audio in
        // Info.plist.
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true, options: [])
        } catch {
            print("[Wax] AVAudioSession setup failed: \\(error)")
        }

        // Hand lock-screen / Control Center transport controls to the
        // page's MediaSession handlers (player store sets actionHandler
        // for play/pause/prev/next).
        UIApplication.shared.beginReceivingRemoteControlEvents()

        return true`,
    ),
);

// ── Android ─────────────────────────────────────────────────────────
patchFile(
  path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'),
  'Android background audio permissions',
  'FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  (s) => s.replace(
    /(<uses-permission android:name="android.permission.INTERNET" \/>)\s*<\/manifest>/,
    `$1
    <!-- Background audio: keeps the WebView's <audio> playing when the
         screen turns off / the app is backgrounded. -->
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
</manifest>`,
  ),
);

console.log('[setup-native] done');
