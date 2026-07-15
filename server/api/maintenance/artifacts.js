import process from 'node:process';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { PackageArtifactStore } from '../storage/package-artifact-store.js';
import { ArtifactMaintenanceService } from '../services/artifact-maintenance-service.js';

const COMMANDS = new Set([
  'audit',
  'quarantine',
  'quarantine-orphans',
  'restore',
  'purge-expired',
]);

function usage() {
  return `Published artifact maintenance

Usage:
  npm run artifacts:maintain -- audit [--json]
  npm run artifacts:maintain -- quarantine <worksheet|roleplayscene> <publishedId> --reason <text> [--yes] [--json]
  npm run artifacts:maintain -- quarantine-orphans --all --reason <text> [--yes] [--json]
  npm run artifacts:maintain -- restore <quarantineId> [--yes] [--json]
  npm run artifacts:maintain -- purge-expired [--apply] [--yes] [--json]

Destructive commands require an interactive confirmation unless --yes is supplied.
Configuration is loaded from DATABASE_URL and STORAGE_ROOT using the API config loader.`;
}

export function parseArtifactMaintenanceArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (command === '-h' || command === '--help') {
    return {
      command: 'audit',
      positional: [],
      reason: '',
      yes: false,
      json: false,
      apply: false,
      all: false,
      help: true,
    };
  }
  if (!COMMANDS.has(command)) {
    throw new Error(command ? `Unknown command: ${command}` : 'A maintenance command is required.');
  }

  const options = {
    command,
    positional: [],
    reason: '',
    yes: false,
    json: false,
    apply: false,
    all: false,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (token === '--reason') {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error('--reason requires a value.');
      options.reason = value.trim();
    } else if (token === '--yes') {
      options.yes = true;
    } else if (token === '--json') {
      options.json = true;
    } else if (token === '--apply') {
      options.apply = true;
    } else if (token === '--all') {
      options.all = true;
    } else if (token === '-h' || token === '--help') {
      options.help = true;
    } else if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      options.positional.push(token);
    }
  }

  return options;
}

function operatorFromEnv(env) {
  return String(env.SUDO_USER || env.USER || env.USERNAME || '').trim();
}

function totalSize(rows) {
  return rows.reduce((sum, row) => sum + Number(row.sizeBytes || row.artifact_size_bytes || 0), 0);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

function writeJson(output, value) {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printPublication(output, inspected) {
  if (inspected.state === 'active') {
    const row = inspected.publication;
    output.write(`type: ${inspected.artifactKind}\n`);
    output.write(`id: ${row.published_package_id || row.roleplayscene_published_scene_id}\n`);
    output.write(`title: ${row.title}\n`);
    output.write(`owner: ${row.owner_email || row.owner_name || row.owner_sub || '-'}\n`);
    output.write(`published: ${new Date(row.published_at).toISOString()}\n`);
    output.write(`artifact: ${row.artifact_path} (${formatBytes(row.artifact_size_bytes)})\n`);
  } else {
    const row = inspected.quarantine;
    output.write(`type: ${inspected.artifactKind}\n`);
    output.write(`id: ${row.original_published_id}\n`);
    output.write(`quarantine id: ${row.quarantine_id}\n`);
    output.write(`status: ${row.status}\n`);
    output.write(`title: ${row.title || '-'}\n`);
    output.write(`artifact: ${row.original_artifact_path}\n`);
  }
}

async function confirmWord({
  word,
  yes,
  input,
  output,
  isInteractive,
}) {
  if (yes) return true;
  if (!isInteractive) {
    throw new Error(`Non-interactive execution requires --yes to confirm ${word}.`);
  }
  const prompt = readline.createInterface({ input, output });
  try {
    const answer = await prompt.question(`Type ${word} to confirm: `);
    return answer.trim() === word;
  } finally {
    prompt.close();
  }
}

function validateCommandShape(options) {
  const count = options.positional.length;
  if (options.command === 'audit' && count !== 0) throw new Error('audit does not accept positional arguments.');
  if (options.command === 'quarantine' && count !== 2) {
    throw new Error('quarantine requires a type and published ID.');
  }
  if (options.command === 'quarantine-orphans' && count !== 0) {
    throw new Error('quarantine-orphans does not accept positional arguments.');
  }
  if (options.command === 'restore' && count !== 1) throw new Error('restore requires a quarantine ID.');
  if (options.command === 'purge-expired' && count !== 0) {
    throw new Error('purge-expired does not accept positional arguments.');
  }
  if (['quarantine', 'quarantine-orphans'].includes(options.command) && !options.reason) {
    throw new Error('--reason is required for quarantine operations.');
  }
  if (options.command === 'quarantine-orphans' && !options.all) {
    throw new Error('quarantine-orphans requires --all.');
  }
  if (options.apply && options.command !== 'purge-expired') {
    throw new Error('--apply is only valid with purge-expired.');
  }
}

export async function runArtifactMaintenanceCli({
  argv = process.argv.slice(2),
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  configLoader = loadConfig,
  poolFactory = createPool,
  artifactStoreFactory = (config) => new PackageArtifactStore({ storageRoot: config.storageRoot }),
  serviceFactory = ({ db, artifactStore }) => new ArtifactMaintenanceService({ db, artifactStore }),
  isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
} = {}) {
  let options;
  try {
    options = parseArtifactMaintenanceArgs(argv);
    if (options.help) {
      output.write(`${usage()}\n`);
      return 0;
    }
    validateCommandShape(options);
  } catch (error) {
    errorOutput.write(`${error.message}\n\n${usage()}\n`);
    return 1;
  }

  const requestedBy = operatorFromEnv(env);
  if (!requestedBy && options.command !== 'audit' && !(options.command === 'purge-expired' && !options.apply)) {
    errorOutput.write('Unable to determine administrator identity from SUDO_USER, USER, or USERNAME.\n');
    return 1;
  }

  let db;
  try {
    const config = configLoader(env);
    db = poolFactory(config);
    const artifactStore = artifactStoreFactory(config);
    const service = serviceFactory({ db, artifactStore, config });

    if (options.command === 'audit') {
      const result = await service.audit();
      if (options.json) writeJson(output, result);
      else {
        output.write(`healthy: ${result.totals.healthy}\n`);
        output.write(`missing files: ${result.totals.missing}\n`);
        output.write(`orphan candidates: ${result.totals.orphaned} (${formatBytes(totalSize(result.orphaned))})\n`);
        output.write(`young unreferenced files: ${result.totals.youngUnreferenced}\n`);
        output.write(`active quarantine records: ${result.totals.quarantined}\n`);
        for (const row of result.missing) {
          output.write(`MISSING ${row.artifactKind} ${row.publishedId} ${row.artifactPath}\n`);
        }
        for (const row of result.orphaned) {
          output.write(`ORPHAN ${row.artifactPath} ${formatBytes(row.sizeBytes)} ${row.modifiedAt}\n`);
        }
      }
      return result.totals.missing > 0 ? 2 : 0;
    }

    if (options.command === 'quarantine') {
      const [kind, publishedId] = options.positional;
      const inspected = await service.inspectPublication(kind, publishedId);
      if (!inspected) throw new Error('Published artifact was not found.');
      if (!options.json) printPublication(output, inspected);
      const confirmed = await confirmWord({
        word: 'QUARANTINE',
        yes: options.yes,
        input,
        output,
        isInteractive,
      });
      if (!confirmed) {
        output.write('Quarantine cancelled.\n');
        return 1;
      }
      const result = await service.quarantinePublication({
        kind,
        publishedId,
        requestedBy,
        reason: options.reason,
        automatedConfirmation: options.yes,
      });
      if (options.json) writeJson(output, result);
      else if (result.ok) {
        output.write(`Quarantined as ${result.quarantine.quarantine_id}; purge after ${new Date(result.quarantine.purge_after).toISOString()}.\n`);
      } else {
        errorOutput.write(`Quarantine failed: ${result.code}${result.error ? ` (${result.error})` : ''}\n`);
      }
      return result.ok ? 0 : 2;
    }

    if (options.command === 'quarantine-orphans') {
      const audit = await service.audit();
      const pendingOrphans = audit.quarantined.filter(
        (row) => row.artifact_kind === 'orphan' && row.status === 'pending_quarantine'
      );
      if (!options.json) {
        output.write(`orphan candidates: ${audit.orphaned.length}\n`);
        output.write(`total size: ${formatBytes(totalSize(audit.orphaned))}\n`);
        output.write(`pending orphan moves to resume: ${pendingOrphans.length}\n`);
      }
      if (audit.orphaned.length === 0 && pendingOrphans.length === 0) {
        if (options.json) writeJson(output, { resumed: 0, candidates: 0, results: [] });
        return 0;
      }
      const confirmed = await confirmWord({
        word: 'QUARANTINE',
        yes: options.yes,
        input,
        output,
        isInteractive,
      });
      if (!confirmed) {
        output.write('Orphan quarantine cancelled.\n');
        return 1;
      }
      const result = await service.quarantineOrphans({
        requestedBy,
        reason: options.reason,
        automatedConfirmation: options.yes,
      });
      if (options.json) writeJson(output, result);
      else {
        const succeeded = result.results.filter((row) => row.ok).length;
        output.write(`quarantined or resumed: ${succeeded}/${result.resumed + result.candidates}\n`);
        for (const row of result.results.filter((item) => !item.ok)) {
          errorOutput.write(`FAILED ${row.artifactPath || '-'} ${row.code}${row.error ? `: ${row.error}` : ''}\n`);
        }
      }
      return result.results.every((row) => row.ok) ? 0 : 2;
    }

    if (options.command === 'restore') {
      const [quarantineId] = options.positional;
      const row = await service.inspectQuarantine(quarantineId);
      if (!row) throw new Error('Quarantine record was not found.');
      if (!options.json) {
        output.write(`quarantine id: ${row.quarantine_id}\n`);
        output.write(`type: ${row.artifact_kind}\n`);
        output.write(`status: ${row.status}\n`);
        output.write(`title: ${row.title || '-'}\n`);
        output.write(`original path: ${row.original_artifact_path}\n`);
      }
      const confirmed = await confirmWord({
        word: 'RESTORE',
        yes: options.yes,
        input,
        output,
        isInteractive,
      });
      if (!confirmed) {
        output.write('Restore cancelled.\n');
        return 1;
      }
      const result = await service.restore({
        quarantineId,
        requestedBy,
        automatedConfirmation: options.yes,
      });
      if (options.json) writeJson(output, result);
      else if (result.ok) output.write('Restore complete.\n');
      else errorOutput.write(`Restore failed: ${result.code}${result.error ? ` (${result.error})` : ''}\n`);
      return result.ok ? 0 : 2;
    }

    const preview = await service.purgeExpired({ apply: false });
    if (!options.json) {
      output.write(`expired quarantine records: ${preview.candidates.length}\n`);
      output.write(`total size: ${formatBytes(totalSize(preview.candidates))}\n`);
    }
    if (!options.apply || preview.candidates.length === 0) {
      if (options.json) writeJson(output, preview);
      else if (!options.apply) output.write('Dry-run only. Add --apply to purge expired artifacts.\n');
      return 0;
    }
    const confirmed = await confirmWord({
      word: 'PURGE',
      yes: options.yes,
      input,
      output,
      isInteractive,
    });
    if (!confirmed) {
      output.write('Purge cancelled.\n');
      return 1;
    }
    const result = await service.purgeExpired({
      apply: true,
      requestedBy,
      automatedConfirmation: options.yes,
    });
    if (options.json) writeJson(output, result);
    else {
      const succeeded = result.results.filter((row) => row.ok).length;
      output.write(`purged: ${succeeded}/${result.candidates.length}\n`);
    }
    return result.results.every((row) => row.ok) ? 0 : 2;
  } catch (error) {
    errorOutput.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    return 2;
  } finally {
    await db?.end?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runArtifactMaintenanceCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
