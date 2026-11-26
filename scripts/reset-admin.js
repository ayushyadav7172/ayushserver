'use strict';

/**
 * CLI Tool: Admin Password Reset & Recovery
 * 
 * Used directly from Termux terminal if the admin user forgets their password.
 * Only accessible to someone with physical/terminal access to the device.
 * 
 * Usage:
 *   node scripts/reset-admin.js                (Interactive mode)
 *   npm run reset-admin                        (Interactive mode shortcut)
 *   node scripts/reset-admin.js --reset        (Clear admin to re-enable setup on web)
 *   node scripts/reset-admin.js --username <user> --password <pass>
 */

const readline = require('readline');
const { databaseManager } = require('../database/database');

databaseManager.init();

function formatTime(ts) {
  if (!ts) return 'Never';
  return new Date(ts).toLocaleString();
}

function printHeader() {
  console.log('\n======================================================');
  console.log('       🛡️  AyushServer - Admin Account Recovery       ');
  console.log('======================================================\n');
}

async function runCli() {
  const args = process.argv.slice(2);

  // Status check
  if (args.includes('--status')) {
    printHeader();
    const admins = databaseManager.getAllAdmins();
    if (admins.length === 0) {
      console.log('ℹ️  No admin account exists yet.');
      console.log('👉 Open http://localhost:3000/login to complete initial setup.\n');
    } else {
      console.log(`✅ ${admins.length} Admin account(s) found:`);
      admins.forEach((a, i) => {
        console.log(`   [${i + 1}] Username: "${a.username}" | Created: ${formatTime(a.created_at)} | Last Login: ${formatTime(a.last_login)}`);
      });
      console.log('');
    }
    process.exit(0);
  }

  // Quick reset flag
  if (args.includes('--reset')) {
    printHeader();
    databaseManager.clearAllAdmins();
    console.log('✅ Admin accounts and sessions have been completely cleared.');
    console.log('👉 Open http://localhost:3000/login in your browser to create a fresh admin account.\n');
    process.exit(0);
  }

  // Quick username & password flag
  const uIdx = args.indexOf('--username');
  const pIdx = args.indexOf('--password');
  if (pIdx !== -1 && args[pIdx + 1]) {
    printHeader();
    const newPass = args[pIdx + 1].trim();
    if (newPass.length < 6) {
      console.error('❌ Password must be at least 6 characters long.\n');
      process.exit(1);
    }

    const admins = databaseManager.getAllAdmins();
    if (admins.length === 0) {
      const newUser = (uIdx !== -1 && args[uIdx + 1]) ? args[uIdx + 1].trim() : 'admin';
      const crypto = require('crypto');
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = crypto.scryptSync(newPass, salt, 64).toString('hex');
      databaseManager.createUser({ username: newUser, passwordHash, salt, role: 'admin' });
      console.log(`✅ Admin account "${newUser}" created successfully.`);
    } else {
      const targetUser = (uIdx !== -1 && args[uIdx + 1]) ? args[uIdx + 1].trim() : admins[0].username;
      const success = databaseManager.resetAdminPassword(targetUser, newPass);
      if (success) {
        console.log(`✅ Password for admin "${targetUser}" updated successfully!`);
      } else {
        console.error(`❌ Admin user "${targetUser}" not found.`);
        process.exit(1);
      }
    }
    console.log('👉 You can now log in at http://localhost:3000/login\n');
    process.exit(0);
  }

  // Interactive Prompt Mode
  printHeader();
  const admins = databaseManager.getAllAdmins();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (query) => new Promise(resolve => rl.question(query, resolve));

  if (admins.length === 0) {
    console.log('ℹ️  No admin account exists in the database currently.');
    const answer = await question('Would you like to create one now from terminal? (y/n): ');
    if (answer.toLowerCase().startsWith('y')) {
      const username = (await question('Enter new admin username (min 3 chars): ')).trim();
      if (!username || username.length < 3) {
        console.log('❌ Invalid username. Aborting.');
        rl.close();
        return;
      }
      const password = (await question('Enter new password (min 6 chars): ')).trim();
      if (!password || password.length < 6) {
        console.log('❌ Password must be at least 6 characters long. Aborting.');
        rl.close();
        return;
      }
      const crypto = require('crypto');
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
      databaseManager.createUser({ username, passwordHash, salt, role: 'admin' });
      console.log(`\n🎉 Admin "${username}" created! You can now log in on http://localhost:3000/login\n`);
    } else {
      console.log('👉 Open http://localhost:3000/login in your browser to complete setup.');
    }
    rl.close();
    return;
  }

  console.log('Current Admin Account(s):');
  admins.forEach((a, i) => {
    console.log(` [${i + 1}] Username: "${a.username}" (Created: ${formatTime(a.created_at)})`);
  });
  console.log('\nSelect an action:');
  console.log(' [1] Set a new password for an existing admin');
  console.log(' [2] Change admin username & password');
  console.log(' [3] Complete Reset (Delete admin to show initial setup on web again)');
  console.log(' [4] Exit\n');

  const choice = (await question('Enter choice (1-4): ')).trim();

  if (choice === '1') {
    const adminUser = admins[0].username;
    const newPass = (await question(`Enter new password for "${adminUser}" (min 6 chars): `)).trim();
    if (!newPass || newPass.length < 6) {
      console.log('❌ Password must be at least 6 characters. Aborted.');
    } else {
      databaseManager.resetAdminPassword(adminUser, newPass);
      console.log(`\n✅ Password updated successfully for "${adminUser}"!`);
      console.log('👉 You can now log in at http://localhost:3000/login\n');
    }
  } else if (choice === '2') {
    const oldUser = admins[0].username;
    const newUser = (await question(`Enter new username (currently "${oldUser}"): `)).trim();
    const newPass = (await question('Enter new password (min 6 chars): ')).trim();
    if (!newUser || newUser.length < 3) {
      console.log('❌ Username must be at least 3 characters. Aborted.');
    } else if (!newPass || newPass.length < 6) {
      console.log('❌ Password must be at least 6 characters. Aborted.');
    } else {
      databaseManager.updateAdminCredentials(oldUser, newUser, newPass);
      console.log(`\n✅ Credentials updated to "${newUser}"!`);
      console.log('👉 You can now log in at http://localhost:3000/login\n');
    }
  } else if (choice === '3') {
    const confirm = (await question('Are you sure you want to reset admin? (yes/no): ')).trim().toLowerCase();
    if (confirm === 'yes' || confirm === 'y') {
      databaseManager.clearAllAdmins();
      console.log('\n✅ Admin account removed. The website will now show the initial setup form.');
      console.log('👉 Open http://localhost:3000/login to register a fresh admin.\n');
    } else {
      console.log('Reset cancelled.');
    }
  } else {
    console.log('Exiting.');
  }

  rl.close();
}

runCli().catch(err => {
  console.error('Error running reset tool:', err);
  process.exit(1);
});
