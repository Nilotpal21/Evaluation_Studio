/**
 * KMS Encryption Round-Trip Test
 *
 * Tests the encryption plugin end-to-end using EnvironmentVariable model by:
 * 1. Connecting to MongoDB with the encryption plugin active
 * 2. Creating a document with an encrypted field (encryptedValue)
 * 3. Reading the raw MongoDB document to verify encryption at rest
 * 4. Reading via Mongoose to verify decryption works
 * 5. Cleaning up
 *
 * Run: npx tsx scripts/kms-encryption-roundtrip.ts
 */

import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';

const MONGO_URL =
  process.env.MONGODB_URL ||
  'mongodb://localhost:27017/abl_platform?authSource=admin&directConnection=true';
const MASTER_KEY =
  process.env.ENCRYPTION_MASTER_KEY ||
  '507f048e098f2282d72d04ccc02e84f9a0200ba23d154e31dfed46f507af0d66';
const TENANT_ID = 'tenant-dev-001';

let pass = 0;
let fail = 0;

function ok(msg: string) {
  pass++;
  console.log(`  \x1b[32mPASS\x1b[0m ${msg}`);
}
function ng(msg: string, detail: string) {
  fail++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${msg}: ${detail}`);
}

async function main() {
  console.log('===========================================');
  console.log(' KMS Encryption Round-Trip Test');
  console.log('===========================================\n');

  // 1. Set master key before importing models
  console.log('[Setup] Setting master key...');
  const { setMasterKey } = await import('@agent-platform/database/models');
  setMasterKey(MASTER_KEY);
  ok('Master key set');

  // 2. Connect to MongoDB
  console.log('[Setup] Connecting to MongoDB...');
  // The models import may auto-connect. Check state first.
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(MONGO_URL);
  } else if (mongoose.connection.readyState === 2) {
    // Connecting — wait
    await new Promise<void>((resolve) => mongoose.connection.once('open', resolve));
  }
  // else readyState 1 = already connected
  ok(`Connected to MongoDB (state: ${mongoose.connection.readyState})`);

  // 3. Import the EnvironmentVariable model (has encryptionPlugin with encryptedValue)
  const { EnvironmentVariable } = await import('@agent-platform/database/models');

  const testKey = `KMS_TEST_${randomUUID().slice(0, 8)}`;
  const plaintext = `super-secret-${randomUUID()}`;

  try {
    // 4. Create a document with encrypted field
    console.log('\n[Test] Creating document with encrypted field...');
    const doc = await EnvironmentVariable.create({
      tenantId: TENANT_ID,
      projectId: 'test-project',
      environment: 'production',
      key: testKey,
      encryptedValue: plaintext,
      isSecret: true,
      createdBy: 'kms-test-script',
    });
    ok(`Document created: ${doc._id}`);

    // 5. Read raw from MongoDB (bypassing Mongoose) to verify encryption at rest
    console.log('[Test] Checking raw MongoDB document (bypassing Mongoose)...');
    const rawDoc = await mongoose.connection.db
      .collection('environment_variables')
      .findOne({ key: testKey });

    if (!rawDoc) {
      ng('Raw read', 'Document not found in MongoDB');
    } else {
      const rawValue = rawDoc.encryptedValue as string;
      console.log(`  Raw encryptedValue prefix: "${rawValue?.substring(0, 40)}"`);
      console.log(`  Raw encryptedValue length: ${rawValue?.length}`);
      console.log(`  Plaintext length: ${plaintext.length}`);

      if (rawValue === plaintext) {
        ng('Encryption at rest', 'VALUE IS PLAINTEXT IN MONGODB — ENCRYPTION NOT WORKING!');
      } else if (!rawValue || rawValue.length === 0) {
        ng('Encryption at rest', 'Value is empty');
      } else {
        ok('Value is NOT plaintext in MongoDB (encrypted at rest)');

        // Check version prefix
        if (/^(v[123]:|enc:)/.test(rawValue)) {
          ok(`Encrypted with version prefix: "${rawValue.substring(0, 3)}"`);
        } else {
          console.log(`  \x1b[33mWARN\x1b[0m No version prefix detected (may use legacy format)`);
        }

        // Check fieldsToEncrypt metadata
        const fields = rawDoc.fieldsToEncrypt as string[] | undefined;
        if (fields && fields.includes('encryptedValue')) {
          ok('fieldsToEncrypt metadata includes "encryptedValue"');
        } else {
          console.log(`  \x1b[33mWARN\x1b[0m fieldsToEncrypt: ${JSON.stringify(fields)}`);
        }
      }
    }

    // 6. Read via Mongoose to verify decryption
    console.log('[Test] Reading via Mongoose (should decrypt)...');
    const readDoc = await EnvironmentVariable.findOne({ key: testKey });

    if (!readDoc) {
      ng('Mongoose read', 'Document not found via Mongoose');
    } else {
      const decrypted = (readDoc as any).encryptedValue;
      console.log(`  Decrypted value prefix: "${decrypted?.substring(0, 30)}..."`);

      if (decrypted === plaintext) {
        ok('Decryption round-trip successful — value matches original');
      } else {
        ng(
          'Decryption',
          `Value mismatch. Expected "${plaintext.substring(0, 20)}...", got "${decrypted?.substring(0, 20)}..."`,
        );
      }
    }

    // 7. Test update encryption (findOne + save pattern)
    console.log('[Test] Updating encrypted field via findOne+save...');
    const newPlaintext = `updated-secret-${randomUUID()}`;
    if (readDoc) {
      (readDoc as any).encryptedValue = newPlaintext;
      await readDoc.save();

      // Read raw from MongoDB — the value should be encrypted, not plaintext
      const rawUpdated = await mongoose.connection.db
        .collection('environment_variables')
        .findOne({ key: testKey });
      const rawVal = rawUpdated?.encryptedValue as string;
      console.log(`  Raw updated value prefix: "${rawVal?.substring(0, 40)}"`);
      if (rawUpdated && rawVal !== newPlaintext && rawVal && rawVal.length > 0) {
        ok('Updated value is encrypted at rest');
      } else if (!rawUpdated) {
        ng('Update encryption', 'Document not found after update');
      } else {
        ng(
          'Update encryption',
          `Value appears as plaintext in MongoDB: "${rawVal?.substring(0, 30)}"`,
        );
      }

      // Verify Mongoose reads updated value
      const readUpdated = await EnvironmentVariable.findOne({ key: testKey });
      if (readUpdated && (readUpdated as any).encryptedValue === newPlaintext) {
        ok('Updated value decrypts correctly');
      } else {
        ng('Update decryption', 'Updated value does not decrypt to expected');
      }
    }

    // 8. Clean up
    console.log('\n[Cleanup] Removing test document...');
    await EnvironmentVariable.deleteOne({ key: testKey });
    ok('Test document cleaned up');
  } catch (err: unknown) {
    ng('Unexpected error', err instanceof Error ? err.message : String(err));
    // Attempt cleanup
    try {
      await mongoose.connection.db.collection('environment_variables').deleteOne({ key: testKey });
    } catch {
      // ignore cleanup errors
    }
  }

  // 9. Summary
  await mongoose.disconnect();
  console.log('\n===========================================');
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log('===========================================');

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
