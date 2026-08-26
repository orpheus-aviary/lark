// Criterion 29: a song whose source died, with and without a model.
//
// `reidentifySource` (`portable/download/pipeline.ts`) is the fourth thing a
// model unlocks on this phone, and the only one that cannot be reached from a
// screen — there is no "redownload" button in the product yet, so a bogus key
// has to be planted and `enqueueRedownload` called directly. Hence this file
// rather than a device gesture.
//
// ⚠️ THIS SUITE DELIBERATELY DOES NOT `resetInstall()`, and that is load-bearing
// rather than lazy. The model's url / model / api_format live in
// `local_metadata` — inside the database file `resetInstall()` deletes — so a
// suite that started from a blank install would have wiped the very
// configuration criterion 29's second half is about, and would then "prove"
// SOURCE_GONE twice. It runs against the library that is there, seeds its own
// song, and takes it away again.
//
// The corollary, for whoever runs this: **any other suite run before this one
// takes the model with it.** ⓪ says so in as many words rather than letting ②
// fail as though reidentification were broken.

import {
  type LlmEndpoint,
  createBilibiliClient,
  preflightSingle,
  readLlmEndpoint,
  resolveOne,
  writeLlmEndpoint,
} from '@lark/core/portable';
import { File } from 'expo-file-system';
import { type BootResult, runBootSequence } from '../boot/sequence';
import { createDownloadRuntime } from '../downloads/engine';
import { songDirectory } from '../ports/paths';
import { createLibrary } from '../services/library';
import type { ScenarioRow } from './d16';
import { awaitTask, subjectVideo } from './downloads';

const client = createBilibiliClient();

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * A cid that does not exist, on a bvid that does.
 *
 * Both halves matter: `probeSourceKey` fetches the page list for the bvid and
 * looks for the cid in it, so a bogus BVID would fail at the fetch and a bogus
 * CID fails at the lookup — and only the second is the state the criterion is
 * about ("the part behind this key is gone").
 */
const DEAD_CID = 999_999_999;

/** ① is what makes ②–④ possible; saying so beats four identical assertions. */
function requireSong(songId: string | null): string {
  if (songId === null) throw new Error('① 没有造出歌来，后面几条无从谈起');
  return songId;
}

async function row(name: string, run: () => Promise<string>): Promise<ScenarioRow> {
  try {
    return { name, ok: true, detail: await run() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** The empty endpoint, keeping the format so only the two that matter change. */
const emptied = (saved: LlmEndpoint): LlmEndpoint => ({
  url: '',
  model: '',
  api_format: saved.api_format,
});

export async function runReidentifyScenarios(): Promise<ScenarioRow[]> {
  const rows: ScenarioRow[] = [];
  const boot: BootResult = await runBootSequence();
  const { engine, fileOps } = createDownloadRuntime(boot);
  const library = createLibrary(boot, fileOps);
  const saved = readLlmEndpoint(boot.deviceSettings);
  let songId: string | null = null;

  try {
    rows.push(
      await row('⓪ 这台设备上有模型吗', async () => {
        expect(
          saved.url.trim() !== '' && saved.model.trim() !== '',
          '这台设备上没有模型配置——先装生产构建、在设置页填一遍，' +
            '并且不要在本套件之前跑任何会重置安装的套件（那会连库带配置一起删掉）',
        );
        return `${saved.api_format} · ${saved.url} · ${saved.model}`;
      }),
    );
    if (rows[0]?.ok !== true) return rows;

    rows.push(
      await row('① 造一首真的歌，再把它的来源弄死', async () => {
        const { bvid } = subjectVideo();
        const item = await resolveOne(client, `https://www.bilibili.com/video/${bvid}`);
        const target = await preflightSingle({ client, hasLlm: false }, item, 'original');
        const task = await awaitTask(engine.enqueueDownload({ target, playlistIds: [] }).id);
        expect(task.state === 'succeeded', `下载没成功：${task.error_message ?? task.state}`);
        const created = task.result?.song_id;
        expect(created !== undefined, '成功的任务没有报出 song_id');
        songId = created as string;

        // The product's own "edit the link" path, not raw SQL: what a person
        // would do by hand is what the failure has to come out of.
        const dead = `${bvid}:${DEAD_CID}`;
        const song = library.updateSong(songId, { source_key: dead });
        expect(song.source_key === dead, `source_key 没改成 ${dead}`);
        return `${song.name} · ${song.source_key}`;
      }),
    );

    rows.push(
      await row('② 无 LLM → SOURCE_GONE，且说得出怎么修', async () => {
        await writeLlmEndpoint(boot.deviceSettings, emptied(saved));
        // The engine reads the config per task (N4e-1), so this takes effect on
        // the next one without rebuilding anything.
        const task = await awaitTask(engine.enqueueRedownload(requireSong(songId)).id);
        expect(task.state === 'failed', `期望 failed，得到 ${task.state}`);
        expect(task.error_code === 'SOURCE_GONE', `error_code 是 ${task.error_code}`);
        const message = task.error_message ?? '';
        expect(message.includes('原来的来源已失效'), `文案没说来源失效：${message}`);
        expect(message.includes('配置 LLM'), `文案没说怎么修：${message}`);
        return message;
      }),
    );

    rows.push(
      await row('③ 有 LLM → 重新识别并下成', async () => {
        await writeLlmEndpoint(boot.deviceSettings, saved);
        const dead = `${subjectVideo().bvid}:${DEAD_CID}`;
        const task = await awaitTask(engine.enqueueRedownload(requireSong(songId)).id);
        expect(
          task.state === 'succeeded',
          `${task.state}：${task.error_code ?? ''} ${task.error_message ?? ''}`,
        );
        const song = library.getSong(requireSong(songId));
        // NOT "it found the same video": the model searched by name and artist,
        // and a cover with the right name is a legitimate answer to that. What
        // has to be true is that the dead key is gone and a file arrived.
        expect(song.source_key !== dead, '来源没变，那它并没有重新识别');
        expect(song.has_file === true, '库里说这首歌没有文件');
        expect(new File(songDirectory(song.id), 'song.m4a').exists, 'song.m4a 不在磁盘上');
        return `${song.name} · ${song.artist} · ${song.source_key}`;
      }),
    );

    rows.push(
      await row('④ 收尾：把这首歌删掉', async () => {
        await library.deleteSong(requireSong(songId));
        songId = null;
        expect(readLlmEndpoint(boot.deviceSettings).url === saved.url, '模型配置没有还原');
        return '曲库回到运行前的样子';
      }),
    );
    return rows;
  } finally {
    // Belt and braces: ③ restores the endpoint on the happy path, and this
    // catches the one that matters — ② throwing after it emptied the config
    // would otherwise leave the phone looking like it never had a model.
    await writeLlmEndpoint(boot.deviceSettings, saved);
    boot.handle.closeSync();
  }
}
