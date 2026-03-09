#!/usr/bin/env node
const https = require('https');
const fs = require('fs');

const PASSWORD = "Hanzala143$";
const KS_PASS = "Shibmine2024Secure";
const KS_FILE = "/home/runner/workspace/android-keystore.jks";
const ACCOUNT_ID = "6b96ef5a-c762-46b8-a767-79e8f9d4247b";
const PROJECT_ID = "3388a05b-ebda-4ee3-b143-4ba6eb582017";
const APP_ID = "com.hanzalasha.shibmine";

function gql(session, query, variables) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request({
      hostname: 'api.expo.dev',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'expo-session': session,
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Parse error: ' + d.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function post(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function main() {
  // 1. Login
  console.log('1. Authenticating...');
  const loginResp = await post('api.expo.dev', '/v2/auth/loginAsync', {}, { username: 'hanzalasha', password: PASSWORD });
  const session = loginResp.data?.sessionSecret;
  if (!session) { console.error('Login failed', JSON.stringify(loginResp)); process.exit(1); }
  console.log('   ✓ Logged in as hanzalasha');

  // 2. Upload keystore
  console.log('2. Uploading Android keystore...');
  const ksB64 = fs.readFileSync(KS_FILE).toString('base64');
  const ksResp = await gql(session,
    `mutation CreateKeystore($accountId: ID!, $input: AndroidKeystoreInput!) {
      androidKeystore { createAndroidKeystore(accountId: $accountId, androidKeystoreInput: $input) { id type } }
    }`,
    { accountId: ACCOUNT_ID, input: { base64EncodedKeystore: ksB64, keystorePassword: KS_PASS, keyAlias: 'shibmine', keyPassword: KS_PASS, type: 'JKS' } }
  );
  const ks = ksResp.data?.androidKeystore?.createAndroidKeystore;
  if (!ks) {
    const errs = ksResp.errors?.map(e => e.message).join(' | ');
    console.error('Keystore upload failed:', errs || JSON.stringify(ksResp).slice(0, 400));
    process.exit(1);
  }
  const keystoreId = ks.id;
  console.log('   ✓ Keystore uploaded id=' + keystoreId);

  // 3. Create or get AndroidAppCredentials (top-level container linking project + applicationIdentifier)
  console.log('3. Creating AndroidAppCredentials...');
  const appCredsResp = await gql(session,
    `mutation CreateAppCreds($projectId: ID!, $appId: String!) {
      androidAppCredentials { createAndroidAppCredentials(projectId: $projectId, applicationIdentifier: $appId) { id applicationIdentifier } }
    }`,
    { projectId: PROJECT_ID, appId: APP_ID }
  );
  const appCreds = appCredsResp.data?.androidAppCredentials?.createAndroidAppCredentials;
  if (!appCreds) {
    const errs = appCredsResp.errors?.map(e => e.message).join(' | ');
    // Maybe it already exists — try to fetch it
    console.log('   Create failed (may already exist):', errs);
    console.log('   Trying to fetch existing...');
    const fetchResp = await gql(session,
      `query GetAppCreds($projectId: ID!) {
        app { byId(appId: $projectId) { androidAppCredentials { id applicationIdentifier } } }
      }`,
      { projectId: PROJECT_ID }
    );
    const existing = fetchResp.data?.app?.byId?.androidAppCredentials?.[0];
    if (!existing) {
      console.error('Could not create or fetch AndroidAppCredentials');
      console.error(JSON.stringify(fetchResp).slice(0, 400));
      process.exit(1);
    }
    console.log('   ✓ Found existing appCredsId=' + existing.id);
    var appCredsId = existing.id;
  } else {
    console.log('   ✓ AppCredentials created id=' + appCreds.id);
    var appCredsId = appCreds.id;
  }

  // 4. Create AndroidAppBuildCredentials (links keystore to appCredentials)
  console.log('4. Creating AndroidAppBuildCredentials...');
  const buildCredsResp = await gql(session,
    `mutation CreateBuildCreds($appCredsId: ID!, $input: AndroidAppBuildCredentialsInput!) {
      androidAppBuildCredentials { createAndroidAppBuildCredentials(androidAppCredentialsId: $appCredsId, androidAppBuildCredentialsInput: $input) { id name isDefault } }
    }`,
    { appCredsId: appCredsId, input: { name: 'default', isDefault: true, androidKeystoreId: keystoreId } }
  );
  const buildCreds = buildCredsResp.data?.androidAppBuildCredentials?.createAndroidAppBuildCredentials;
  if (!buildCreds) {
    const errs = buildCredsResp.errors?.map(e => e.message).join(' | ');
    console.error('Build creds failed:', errs || JSON.stringify(buildCredsResp).slice(0, 400));
    process.exit(1);
  }
  console.log('   ✓ Build credentials created id=' + buildCreds.id);

  console.log('\n✅ All credentials configured. Run:');
  console.log('./node_modules/.bin/eas build --profile development --platform android --non-interactive --no-wait');
}

main().catch(e => { console.error(e); process.exit(1); });
