import startViewer from 'prismarine-viewer/lib/mineflayer.js';
import { attachRecording } from './recording.mjs';
import { createBrowserRecording } from './browser-recording.mjs';

export function attachViewer(bot) {
  startViewer(bot, { firstPerson: true, port: 3000, viewDistance: 4 });
  const recording = attachRecording(bot, {
    directory: process.env.MINE_AI_RECORDING_DIR ?? '/recording',
    createRecorder: options => createBrowserRecording({
      ...options,
      url: 'http://127.0.0.1:3000/',
    }),
  });
  return async () => {
    const status = await recording.stop();
    bot.viewer?.close();
    console.info(`[recording] ${status.state}: ${status.filename}`);
  };
}
