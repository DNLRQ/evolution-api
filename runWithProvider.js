const dotenv = require('dotenv');
const { execSync } = require('child_process');
const { existsSync, rmSync, cpSync, mkdirSync } = require('fs');
const path = require('path');

dotenv.config();

const isWin = process.platform === 'win32';

const { DATABASE_PROVIDER } = process.env;
const databaseProviderDefault = DATABASE_PROVIDER ?? 'postgresql';

if (!DATABASE_PROVIDER) {
  console.warn(`DATABASE_PROVIDER is not set in the .env file, using default: ${databaseProviderDefault}`);
}

function getMigrationsFolder(provider) {
  switch (provider) {
    case 'psql_bouncer':
      return 'postgresql-migrations';
    default:
      return `${provider}-migrations`;
  }
}

const migrationsFolder = getMigrationsFolder(databaseProviderDefault);

let command = process.argv
  .slice(2)
  .join(' ')
  .replace(/DATABASE_PROVIDER/g, databaseProviderDefault);

const migrationsPattern = new RegExp(`${databaseProviderDefault}-migrations`, 'g');
command = command.replace(migrationsPattern, migrationsFolder);

/** Copia carpeta de migraciones a prisma/migrations (cross-platform). */
function syncMigrationsFolder() {
  const src = path.join('prisma', migrationsFolder);
  const dest = path.join('prisma', 'migrations');
  if (!existsSync(src)) {
    console.error(`No existe la carpeta de migraciones: ${src}`);
    process.exit(1);
  }
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

// db:deploy — reemplazar rm/cp de Unix por sync nativo en Node
const deployUnixPattern =
  /rm\s+-rf\s+\.\/prisma\/migrations\s+&&\s+cp\s+-r\s+\.\/prisma\/[^ ]+\s+\.\/prisma\/migrations\s+&&\s+/;
if (deployUnixPattern.test(command)) {
  syncMigrationsFolder();
  command = command.replace(deployUnixPattern, '');
}

if (command.includes('rmdir') && existsSync('prisma\\migrations')) {
  try {
    execSync('rmdir /S /Q prisma\\migrations', { stdio: 'inherit' });
  } catch (error) {
    console.error(`Error removing directory: prisma\\migrations`);
    process.exit(1);
  }
} else if (command.includes('rmdir')) {
  console.warn(`Directory 'prisma\\migrations' does not exist, skipping removal.`);
}

// db:deploy:win legacy — xcopy antes de migrate deploy
if (isWin && command.includes('xcopy') && command.includes('prisma migrate deploy')) {
  syncMigrationsFolder();
  command = command.replace(/xcopy\s+\/E\s+\/I\s+prisma\\[^ ]+\s+prisma\\migrations\s+&&\s+/i, '');
}

try {
  execSync(command, { stdio: 'inherit' });
} catch (error) {
  console.error(`Error executing command: ${command}`);
  process.exit(1);
}