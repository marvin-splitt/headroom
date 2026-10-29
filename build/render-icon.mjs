// Renders build/icon.svg to build/icon.png, which electron-builder turns into the app icon.
// Run with: npx electron build/render-icon.mjs
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  await win.loadURL(pathToFileURL(path.join(dir, 'icon.svg')).toString());
  await new Promise((r) => setTimeout(r, 500));
  const image = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' });
  fs.writeFileSync(path.join(dir, 'icon.png'), image.toPNG());
  app.quit();
});
