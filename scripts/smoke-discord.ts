import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { Client, GatewayIntentBits } from 'discord.js';

interface OpenClawConfig {
  bindings?: Array<{ match?: { channel?: string; peer?: { id?: string } } }>;
  channels?: { discord?: { token?: string; proxy?: string } };
}

async function main(): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(homedir(), '.openclaw', 'openclaw.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as OpenClawConfig;
  const token = config.channels?.discord?.token;
  const candidateChannels = (config.bindings ?? [])
    .filter((binding) => binding.match?.channel === 'discord')
    .map((binding) => binding.match?.peer?.id)
    .filter((value): value is string => Boolean(value));

  if (!token) {
    throw new Error(`No Discord token found in ${configPath}`);
  }

  if (candidateChannels.length === 0) {
    throw new Error(`No Discord channel bindings found in ${configPath}`);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  await new Promise<void>((resolve, reject) => {
    client.once('clientReady', async () => {
      try {
        const fetchedChannels = [] as string[];

        for (const channelId of candidateChannels) {
          try {
            const channel = await client.channels.fetch(channelId);

            if (!channel || typeof (channel as { send?: unknown }).send !== 'function') {
              continue;
            }

            fetchedChannels.push(channelId);
          } catch {
            continue;
          }
        }

        if (fetchedChannels.length === 0) {
          throw new Error('Bot can log in, but none of the configured Discord channels are sendable.');
        }

        const smokeChannel = await client.channels.fetch(fetchedChannels[0]!);

        if (!smokeChannel || typeof (smokeChannel as { send?: unknown }).send !== 'function') {
          throw new Error('Smoke channel is not sendable.');
        }

        const message = await (smokeChannel as { send: (content: string) => Promise<{ id: string; delete: () => Promise<void> }> }).send(
          'Codex bridge smoke test message. This will be deleted automatically.',
        );
        await message.delete();

        console.log(`Discord smoke succeeded. Checked ${fetchedChannels.length} channel(s).`);
        console.log(`Smoke message round-trip OK on channel ${fetchedChannels[0]}.`);
        await client.destroy();
        resolve();
      } catch (error) {
        await client.destroy();
        reject(error);
      }
    });

    client.login(token).catch(reject);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
