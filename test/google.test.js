'use strict';

// Google Docs, Sheets and Slides client: file links, ranges, the service account token, error words, and the exact
// request each method sends. A fake fetch stands in for Google; nothing here reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createGoogle, GoogleError, parseFileRef, validRange, KINDS, SCOPES, docText, slideTexts } = require('../src/google');
const { tempDirectory } = require('./helpers');

const DOC = '1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
const EMAIL = 'bot@my-project.iam.gserviceaccount.com';
const KEY_ID = 'abc123keyid';
const START = Date.UTC(2027, 6, 1, 12, 0);
const ALLOWED_HOSTS = ['oauth2.googleapis.com', 'www.googleapis.com', 'docs.googleapis.com', 'sheets.googleapis.com', 'slides.googleapis.com'];

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const OTHER_PEM = otherPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
// A distinctive slice of the key body: if it shows up in a message, the key leaked.
const pemBody = pem => pem.split('\n').filter(line => line && !line.startsWith('-----'))[2];

function keyJson(overrides = {}) {
  return { type: 'service_account', project_id: 'my-project', private_key_id: KEY_ID, private_key: PEM, client_email: EMAIL,
    token_uri: 'https://evil.example/token', ...overrides };
}

function writeKey(t, json = keyJson(), name = 'google-key.json') {
  const file = path.join(tempDirectory(t, 'spam-bot-google-'), name);
  fs.writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return file;
}

// A fake Google: answers by "METHOD host/path", records every request, hands out a numbered token.
function fakeGoogle(routes = {}) {
  const requests = [];
  let tokenCount = 0;
  const fetchFn = async (url, options) => {
    const parsed = new URL(url);
    requests.push({ url, host: parsed.hostname, pathname: parsed.pathname, search: parsed.search, ...options,
      json: options.body && options.headers['Content-Type'] === 'application/json' ? JSON.parse(options.body) : undefined });
    const key = `${options.method} ${parsed.hostname}${parsed.pathname}`;
    let route = routes[key];
    if (!route && key === 'POST oauth2.googleapis.com/token') {
      tokenCount += 1;
      route = { body: { access_token: `ya29.test-token-${tokenCount}`, expires_in: 3600, token_type: 'Bearer' } };
    }
    if (typeof route === 'function') route = await route(url, options);
    if (!route) route = { status: 404, body: {} };
    const status = route.status || 200;
    return { ok: status < 300, status, headers: new Map(), json: async () => { if (route.badJson) throw new SyntaxError('bad'); return route.body; } };
  };
  return { requests, fetchFn, apiRequests: () => requests.filter(item => item.host !== 'oauth2.googleapis.com') };
}

function make(t, { routes, json, file, clock, platform, statFile, readFile } = {}) {
  const fake = fakeGoogle(routes);
  const keyFile = file ?? writeKey(t, json);
  const time = { now: START };
  const google = createGoogle({
    getKeyFile: () => keyFile, fetchFn: fake.fetchFn, clock: clock ?? (() => time.now), timeoutMs: 5000,
    ...(platform ? { platform } : {}), ...(statFile ? { statFile } : {}), ...(readFile ? { readFile } : {})
  });
  return { google, fake, time, keyFile };
}

const jwtParts = assertion => {
  const [header, claims, signature] = assertion.split('.');
  const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return { header: decode(header), claims: decode(claims), signed: `${header}.${claims}`, signature: Buffer.from(signature, 'base64url') };
};

async function failure(promise) {
  try { await promise; } catch (error) { assert.ok(error instanceof GoogleError, `GoogleError expected, got ${error?.stack}`); return error.message; }
  assert.fail('expected a GoogleError');
}

test('file links and bare IDs become an ID and a kind; everything else is refused', () => {
  assert.deepEqual(KINDS, ['doc', 'sheet', 'slides']);
  assert.deepEqual(parseFileRef(`https://docs.google.com/document/d/${DOC}/edit?usp=sharing`), { id: DOC, kind: 'doc' });
  assert.deepEqual(parseFileRef(`https://docs.google.com/spreadsheets/d/${DOC}/edit#gid=0`), { id: DOC, kind: 'sheet' });
  assert.deepEqual(parseFileRef(`https://docs.google.com/presentation/d/${DOC}`), { id: DOC, kind: 'slides' });
  assert.deepEqual(parseFileRef(`  https://docs.google.com/u/0/document/d/${DOC}/edit  `), { id: DOC, kind: 'doc' });
  assert.deepEqual(parseFileRef(`https://docs.google.com/u/2/presentation/d/${DOC}/edit`), { id: DOC, kind: 'slides' });
  assert.deepEqual(parseFileRef(DOC), { id: DOC, kind: null });
  assert.deepEqual(parseFileRef(`${DOC.slice(0, 20)}`), { id: DOC.slice(0, 20), kind: null });
  for (const bad of [
    '', 'abc', 'x'.repeat(19), 'x'.repeat(101), `${DOC} extra`, `${DOC}!`, null, undefined, 42,
    `https://drive.google.com/file/d/${DOC}/view`, `https://drive.google.com/open?id=${DOC}`,
    `https://evil.example/document/d/${DOC}/edit`, `https://docs.google.com.evil.example/document/d/${DOC}/edit`,
    `http://docs.google.com/document/d/${DOC}/edit`, `https://user@docs.google.com/document/d/${DOC}/edit`,
    `https://docs.google.com/forms/d/${DOC}/edit`, `https://docs.google.com/document/d/short/edit`,
    `https://docs.google.com/document/d/${DOC}x/y`.replace(DOC, 'x'.repeat(101)), 'https://docs.google.com/document/'
  ]) assert.equal(parseFileRef(bad), null, String(bad));
});

test('ranges: A1 style with an optional sheet name; injection, quotes and long text are refused', () => {
  for (const good of ['A1', 'a1', 'A1:C10', 'A:C', '2:5', 'Sheet1!A1', 'Sheet1!A1:C10', 'Sheet 1!A:C', 'My_sheet-2!2:5',
    "'Budget 2027'!B2:D9", "'Q1 (draft)'!A1", '\'Tom & Jerry\'!A1:B2', 'AA10:ZZ999', '預算!A1:B2']) {
    assert.equal(validRange(good), true, good);
  }
  for (const bad of ['', 'A', '1', 'A1:', ':A1', 'A1:B', 'A:5', 'A1&x=1', 'A1?x=1', 'A1/../B1', 'A1 B1', 'Sheet1!', '!A1',
    "'It's'!A1", "'Budget'A1", "''!A1", "'Budget'!A1!B2", 'Sheet1!A1\n', 'Sheet(1)!A1', 'Sheet&x=1!A1', "'a\nb'!A1", 'A1:C10:D11',
    `'${'x'.repeat(101)}'!A1`, `${'x'.repeat(101)}!A1`, `${'x'.repeat(150)}!A1`, 'AAAA1', 'A12345678', null, undefined, 5]) {
    assert.equal(validRange(bad), false, String(bad));
  }
  assert.equal(validRange(`${'x'.repeat(100)}!A1`), true);
  assert.equal(validRange(`'${'x'.repeat(100)}'!A1:B2`), true);
});

test('the token request: Google\'s fixed address, a form body, a signed JWT, and the scopes', async t => {
  const { google, fake } = make(t, { routes: { ['GET docs.googleapis.com/v1/documents/' + DOC]: { body: { title: 'T', revisionId: 'r1', body: { content: [] } } } } });
  await google.readDoc(DOC);
  const [tokenRequest] = fake.requests;
  assert.equal(tokenRequest.url, 'https://oauth2.googleapis.com/token');
  assert.equal(tokenRequest.method, 'POST');
  assert.equal(tokenRequest.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(tokenRequest.headers.Authorization, undefined);
  const form = new URLSearchParams(tokenRequest.body);
  assert.deepEqual([...form.keys()].sort(), ['assertion', 'grant_type']);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const jwt = jwtParts(form.get('assertion'));
  assert.deepEqual(jwt.header, { alg: 'RS256', typ: 'JWT', kid: KEY_ID });
  assert.deepEqual(jwt.claims, { iss: EMAIL, scope: SCOPES.join(' '), aud: 'https://oauth2.googleapis.com/token',
    iat: START / 1000, exp: START / 1000 + 3600 });
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(jwt.signed), pair.publicKey, jwt.signature), true);
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(jwt.signed), otherPair.publicKey, jwt.signature), false);
  assert.deepEqual(SCOPES, [
    'https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/presentations', 'https://www.googleapis.com/auth/drive.metadata.readonly']);
  assert.equal(fake.requests[1].headers.Authorization, 'Bearer ya29.test-token-1');
  // No private_key_id in the file: no kid in the header.
  const bare = make(t, { json: keyJson({ private_key_id: undefined }), routes: { ['GET docs.googleapis.com/v1/documents/' + DOC]: { body: {} } } });
  await bare.google.readDoc(DOC);
  assert.deepEqual(jwtParts(new URLSearchParams(bare.fake.requests[0].body).get('assertion')).header, { alg: 'RS256', typ: 'JWT' });
});

test('the token is cached until a minute before it runs out, then renewed; another key gets its own', async t => {
  const routes = { ['GET docs.googleapis.com/v1/documents/' + DOC]: { body: { title: 'T', revisionId: 'r', body: { content: [] } } } };
  const { google, fake, time, keyFile } = make(t, { routes });
  const tokenRequests = () => fake.requests.filter(item => item.host === 'oauth2.googleapis.com').length;
  await google.readDoc(DOC);
  await google.readDoc(DOC);
  assert.equal(tokenRequests(), 1);
  time.now = START + (3600 - 61) * 1000;
  await google.readDoc(DOC);
  assert.equal(tokenRequests(), 1);
  time.now = START + (3600 - 60) * 1000;
  await google.readDoc(DOC);
  assert.equal(tokenRequests(), 2);
  assert.equal(fake.requests.at(-1).headers.Authorization, 'Bearer ya29.test-token-2');
  // The claims use the clock at the time of renewal.
  const renewed = jwtParts(new URLSearchParams(fake.requests.filter(item => item.host === 'oauth2.googleapis.com')[1].body).get('assertion'));
  assert.equal(renewed.claims.iat, time.now / 1000);
  // A different private key (or key ID) in the same file path gets a new token straight away.
  fs.writeFileSync(keyFile, JSON.stringify(keyJson({ private_key: OTHER_PEM })));
  await google.readDoc(DOC);
  assert.equal(tokenRequests(), 3);
  assert.equal(fake.requests.at(-1).headers.Authorization, 'Bearer ya29.test-token-3');
  fs.writeFileSync(keyFile, JSON.stringify(keyJson({ private_key: OTHER_PEM, private_key_id: 'second' })));
  await google.readDoc(DOC);
  assert.equal(tokenRequests(), 4);
  // Another service account email is a separate cache entry.
  fs.writeFileSync(keyFile, JSON.stringify(keyJson({ client_email: 'other@my-project.iam.gserviceaccount.com' })));
  await google.readDoc(DOC);
  assert.equal(tokenRequests(), 5);
  await google.readDoc(DOC);
  assert.equal(tokenRequests(), 5);
  // The expiry that Google reports is what counts.
  const short = make(t, { routes: { ...routes, 'POST oauth2.googleapis.com/token': { body: { access_token: 'ya29.short', expires_in: 300 } } } });
  await short.google.readDoc(DOC);
  short.time.now = START + 239 * 1000;
  await short.google.readDoc(DOC);
  assert.equal(short.fake.requests.filter(item => item.host === 'oauth2.googleapis.com').length, 1);
  short.time.now = START + 240 * 1000;
  await short.google.readDoc(DOC);
  assert.equal(short.fake.requests.filter(item => item.host === 'oauth2.googleapis.com').length, 2);
});

test('key problems get plain messages that never carry the private key or a token', async t => {
  const messages = [];
  const note = async promise => { const message = await failure(promise); messages.push(message); return message; };
  // No path at all, or an empty one.
  for (const getKeyFile of [undefined, () => '', () => '   ', () => undefined]) {
    const google = createGoogle({ getKeyFile, fetchFn: async () => assert.fail('no request without a key') });
    assert.match(await note(google.readDoc(DOC)), /no Google service account key yet.*COMMANDS\.md/);
  }
  // A missing file names the file, not the folder.
  const directory = tempDirectory(t, 'spam-bot-google-');
  const missing = make(t, { file: path.join(directory, 'secret-folder', 'missing-key.json') });
  const message = await note(missing.google.readDoc(DOC));
  assert.match(message, /missing-key\.json/);
  assert.doesNotMatch(message, /secret-folder/);
  assert.equal(missing.fake.requests.length, 0);
  // A key file anyone on the server can read (checked with an injected stat, so this runs on Windows too).
  const groupReadable = make(t, { platform: 'linux', statFile: () => ({ mode: 0o100644 }) });
  assert.match(await note(groupReadable.google.readDoc(DOC)), /google-key\.json.*chmod 600/);
  const otherReadable = make(t, { platform: 'linux', statFile: () => ({ mode: 0o100604 }) });
  assert.match(await note(otherReadable.google.readDoc(DOC)), /chmod 600/);
  assert.equal(groupReadable.fake.requests.length + otherReadable.fake.requests.length, 0);
  const ownerOnly = make(t, { platform: 'linux', statFile: () => ({ mode: 0o100600 }), routes: { ['GET docs.googleapis.com/v1/documents/' + DOC]: { body: {} } } });
  await ownerOnly.google.readDoc(DOC);
  const windows = make(t, { platform: 'win32', statFile: () => ({ mode: 0o100666 }), routes: { ['GET docs.googleapis.com/v1/documents/' + DOC]: { body: {} } } });
  await windows.google.readDoc(DOC);
  if (process.platform !== 'win32') {
    const real = make(t);
    fs.chmodSync(real.keyFile, 0o640);
    assert.match(await note(real.google.readDoc(DOC)), /chmod 600/);
  }
  // Not JSON, not a service account, missing parts.
  const cases = [
    ['{ this is not json ' + PEM, /could not be read as JSON/],
    [JSON.stringify(keyJson({ type: 'authorized_user' })), /not a Google service account key/],
    [JSON.stringify([1, 2]), /not a Google service account key/],
    ['null', /not a Google service account key/],
    [JSON.stringify(keyJson({ client_email: 'no-at-sign' })), /no client_email/],
    [JSON.stringify(keyJson({ client_email: 7 })), /no client_email/],
    [JSON.stringify(keyJson({ private_key: undefined })), /no private_key/],
    [JSON.stringify(keyJson({ private_key: 'not a pem' })), /no private_key/]
  ];
  for (const [content, pattern] of cases) {
    const bad = make(t, { json: content });
    assert.match(await note(bad.google.readDoc(DOC)), pattern, content.slice(0, 40));
    assert.equal(bad.fake.requests.length, 0);
  }
  // A PEM that is the right shape but cannot sign.
  const broken = make(t, { json: keyJson({ private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' }) });
  assert.match(await note(broken.google.readDoc(DOC)), /could not be used to sign in/);
  assert.equal(broken.fake.requests.length, 0);
  // The token endpoint refusing the key, with Google's own words in the answer.
  for (const status of [400, 401]) {
    const refused = make(t, { routes: { 'POST oauth2.googleapis.com/token': { status, body: { error: 'invalid_grant', error_description: `Invalid JWT Signature for ${EMAIL} ${PEM}` } } } });
    const text = await note(refused.google.readDoc(DOC));
    assert.match(text, /^Google rejected the service account key: make a new key/);
    assert.equal(refused.fake.requests.length, 1);
  }
  const unreachable = make(t, { routes: { 'POST oauth2.googleapis.com/token': { status: 503, body: {} } } });
  assert.equal(await note(unreachable.google.readDoc(DOC)), 'Google answered with error 503.');
  const noToken = make(t, { routes: { 'POST oauth2.googleapis.com/token': { body: { token_type: 'Bearer' } } } });
  assert.equal(await note(noToken.google.readDoc(DOC)), 'Google\'s answer could not be read.');
  for (const text of messages) {
    for (const secret of [pemBody(PEM), 'BEGIN PRIVATE KEY', 'ya29.']) assert.ok(!text.includes(secret), `${secret} in: ${text}`);
  }
});

test('every request is to a Google address, never redirects, times out, and carries the token only in its header', async t => {
  const { google, fake } = make(t, { routes: {
    ['GET www.googleapis.com/drive/v3/files/' + DOC]: { body: { id: DOC, name: 'N', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/x' } },
    ['GET docs.googleapis.com/v1/documents/' + DOC]: { body: { title: 'T', revisionId: 'r', body: { content: [] } } },
    ['GET sheets.googleapis.com/v4/spreadsheets/' + DOC]: { body: { properties: { title: 'S' }, sheets: [] } },
    ['GET slides.googleapis.com/v1/presentations/' + DOC]: { body: { title: 'P', revisionId: 'r', slides: [] } }
  } });
  await google.fileInfo(DOC);
  await google.readDoc(DOC);
  await google.sheetInfo(DOC);
  await google.readSlides(DOC);
  assert.equal(fake.requests.length, 5);
  assert.deepEqual([...new Set(fake.requests.map(item => item.host))].sort(), [...ALLOWED_HOSTS].sort());
  for (const request of fake.requests) {
    assert.ok(request.url.startsWith('https://'), request.url);
    assert.ok(ALLOWED_HOSTS.includes(request.host), request.host);
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
    assert.equal(request.headers.Accept, 'application/json');
    assert.ok(!request.url.includes('ya29.'), 'the token is not in the address');
  }
  // The key file's own token_uri (here evil.example) is never used.
  assert.ok(!fake.requests.some(item => item.url.includes('evil.example')));
  assert.equal(fake.requests[0].url, 'https://oauth2.googleapis.com/token');
  for (const request of fake.apiRequests()) assert.equal(request.headers.Authorization, 'Bearer ya29.test-token-1');
  assert.equal(fake.requests[0].headers.Authorization, undefined);
  // The timeout is the one passed in: a signal that is already past is aborted.
  const aborted = [];
  const instant = createGoogle({ getKeyFile: () => writeKey(t), timeoutMs: 1, fetchFn: async (url, options) => {
    await new Promise(resolve => setTimeout(resolve, 30));
    aborted.push(options.signal.aborted);
    return { ok: true, status: 200, json: async () => ({ access_token: 'x', expires_in: 3600 }) };
  } });
  await instant.readDoc(DOC);
  assert.deepEqual(aborted, [true, true]);
  // Only file IDs go into an address: nothing is requested for a bad one.
  const refused = await failure(google.readDoc('../../etc/passwd'));
  assert.match(refused, /not a Google file ID/);
  assert.equal(fake.requests.length, 5);
});

test('Google\'s answers become plain words, and the token and key never reach a message', async t => {
  const docUrl = 'GET docs.googleapis.com/v1/documents/' + DOC;
  const run = async (route, key) => {
    const { google, fake } = make(t, { routes: { [docUrl]: route }, json: key });
    return { message: await failure(google.readDoc(DOC)), fake };
  };
  const messages = [];
  const check = async (status, expected, body = {}) => {
    const { message } = await run({ status, body });
    messages.push(message);
    assert.equal(message, expected, String(status));
  };
  await check(401, 'Google rejected the service account key: make a new key in Google Cloud and replace the key file.');
  await check(403, `the service account cannot open it: share the file with ${EMAIL} (Editor to change it, Viewer to read it).`);
  // The API turned off in the Cloud project is a 403 too, and needs a different fix.
  await check(403, 'the Google Docs API is not turned on in the service account\'s Google Cloud project: turn it on under ' +
    '"APIs & Services", wait a few minutes, and try again.', { error: { message: 'Google Docs API has not been used in project 123 before or it is disabled.' } });
  await check(404, `it was not found, or it is not shared with ${EMAIL}.`);
  await check(409, 'the file changed since it was read; read it again and retry.');
  await check(412, 'the file changed since it was read; read it again and retry.');
  await check(429, 'Google\'s rate limit is reached; try again later.');
  await check(500, 'Google answered with error 500.');
  await check(503, 'Google answered with error 503.');
  await check(400, 'Google refused it as invalid.');
  await check(400, 'Google refused it as invalid.', { error: { message: 7 } });
  // A write pinned to an older revision comes back as a 400 that names the revision.
  await check(400, 'the file changed since it was read; read it again and retry.',
    { error: { message: 'The required revision ID \'abc\' does not match the latest revision.' } });
  // A 400 reason: one line, no links, no more than 120 characters, never the token or the key.
  const reasoned = await run({ status: 400, body: { error: { message:
    'Invalid requests[0].insertText:\n the index   is  bad. See https://developers.google.com/docs/api/reference/rest and ya29.test-token-1 now' } } });
  messages.push(reasoned.message);
  assert.equal(reasoned.message, 'Google refused it as invalid: Invalid requests[0].insertText: the index is bad. See and now.');
  const long = await run({ status: 400, body: { error: { message: 'x'.repeat(500) } } });
  assert.equal(long.message, `Google refused it as invalid: ${'x'.repeat(119)}….`);
  const leaking = await run({ status: 400, body: { error: { message: `bad ${PEM} ${pemBody(PEM)}` } } });
  messages.push(leaking.message);
  // A 401 from the API drops the cached token, so the next call signs in again.
  const { google, fake } = make(t, { routes: { [docUrl]: { status: 401, body: {} } } });
  await failure(google.readDoc(DOC));
  await failure(google.readDoc(DOC));
  assert.equal(fake.requests.filter(item => item.host === 'oauth2.googleapis.com').length, 2);
  // A different client_email in the file names that email in the 403.
  const other = await run({ status: 403, body: {} }, keyJson({ client_email: 'someone@else.iam.gserviceaccount.com' }));
  assert.match(other.message, /share the file with someone@else\.iam\.gserviceaccount\.com /);
  // Timeouts, network failures and unreadable answers, for the API and for the token request.
  const timeout = () => { throw new DOMException('The operation timed out.', 'TimeoutError'); };
  const offline = () => { throw new TypeError('fetch failed: ya29.test-token-1 ' + PEM); };
  for (const [fail, expected] of [[timeout, 'Google did not answer in time.'], [offline, 'could not reach Google (network).']]) {
    const viaApi = make(t, { routes: { [docUrl]: fail } });
    messages.push(await failure(viaApi.google.readDoc(DOC)));
    assert.equal(messages.at(-1), expected);
    const viaToken = make(t, { routes: { 'POST oauth2.googleapis.com/token': fail } });
    messages.push(await failure(viaToken.google.readDoc(DOC)));
    assert.equal(messages.at(-1), expected);
  }
  const badJson = make(t, { routes: { [docUrl]: { badJson: true } } });
  assert.equal(await failure(badJson.google.readDoc(DOC)), 'Google\'s answer could not be read.');
  const badTokenJson = make(t, { routes: { 'POST oauth2.googleapis.com/token': { badJson: true } } });
  assert.equal(await failure(badTokenJson.google.readDoc(DOC)), 'Google\'s answer could not be read.');
  for (const text of messages) {
    for (const secret of [pemBody(PEM), 'BEGIN PRIVATE KEY', 'ya29.', 'developers.google.com']) assert.ok(!text.includes(secret), `${secret} in: ${text}`);
  }
  assert.equal(new GoogleError('x').name, 'GoogleError');
  assert.ok(new GoogleError('x') instanceof Error);
});

test('files: fileInfo names the kind from the mime type', async t => {
  const mimes = { 'application/vnd.google-apps.document': 'doc', 'application/vnd.google-apps.spreadsheet': 'sheet',
    'application/vnd.google-apps.presentation': 'slides', 'application/pdf': null };
  for (const [mimeType, kind] of Object.entries(mimes)) {
    const { google, fake } = make(t, { routes: { ['GET www.googleapis.com/drive/v3/files/' + DOC]: { body: {
      id: DOC, name: `  Budget\n‮ 2027  ${'z'.repeat(150)}`, mimeType, webViewLink: `https://docs.google.com/x/d/${DOC}/edit` } } } });
    const info = await google.fileInfo(DOC);
    assert.equal(info.kind, kind, mimeType);
    assert.equal(info.id, DOC);
    assert.equal(info.url, `https://docs.google.com/x/d/${DOC}/edit`);
    assert.equal(info.name, `Budget 2027 ${'z'.repeat(87)}…`);
    assert.equal([...info.name].length, 100);
    const [, request] = fake.requests;
    assert.equal(request.method, 'GET');
    assert.equal(request.url, `https://www.googleapis.com/drive/v3/files/${DOC}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`);
    assert.equal(request.body, undefined);
    assert.equal(request.headers['Content-Type'], undefined);
  }
});

test('docs: read, append and replace send exactly the requests Google expects', async t => {
  const apiDoc = { title: 'Plan', revisionId: 'rev-9', body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Hello\n' } }] } }] } };
  const batch = 'POST docs.googleapis.com/v1/documents/' + DOC + ':batchUpdate';
  const { google, fake } = make(t, { routes: {
    ['GET docs.googleapis.com/v1/documents/' + DOC]: { body: apiDoc },
    [batch]: () => ({ body: fake.requests.at(-1).json.requests[0].replaceAllText
      ? { replies: [{ replaceAllText: { occurrencesChanged: 3 } }], writeControl: { requiredRevisionId: 'rev-11' } }
      : { replies: [{}], writeControl: { requiredRevisionId: 'rev-10' } } })
  } });
  assert.deepEqual(await google.readDoc(DOC), { title: 'Plan', revisionId: 'rev-9', text: 'Hello\n' });
  assert.equal(fake.apiRequests()[0].url, `https://docs.googleapis.com/v1/documents/${DOC}`);
  assert.equal(fake.apiRequests()[0].method, 'GET');
  // Append: a new line, at the end of the body; revision guard only when given.
  assert.deepEqual(await google.appendDoc(DOC, 'Next step', { revisionId: 'rev-9' }), { revisionId: 'rev-10' });
  const append = fake.apiRequests()[1];
  assert.equal(append.url, `https://docs.googleapis.com/v1/documents/${DOC}:batchUpdate`);
  assert.equal(append.method, 'POST');
  assert.equal(append.headers['Content-Type'], 'application/json');
  assert.deepEqual(append.json, { requests: [{ insertText: { endOfSegmentLocation: {}, text: '\nNext step' } }], writeControl: { requiredRevisionId: 'rev-9' } });
  await google.appendDoc(DOC, '');
  assert.deepEqual(fake.apiRequests()[2].json, { requests: [{ insertText: { endOfSegmentLocation: {}, text: '\n' } }] });
  assert.ok(!('writeControl' in fake.apiRequests()[2].json));
  // Replace.
  assert.deepEqual(await google.replaceInDoc(DOC, 'old', 'new', { revisionId: 'rev-10' }), { changed: 3 });
  assert.deepEqual(fake.apiRequests()[3].json, { requests: [{ replaceAllText: { containsText: { text: 'old', matchCase: true }, replaceText: 'new' } }],
    writeControl: { requiredRevisionId: 'rev-10' } });
  await google.replaceInDoc(DOC, 'gone', '');
  assert.deepEqual(fake.apiRequests()[4].json, { requests: [{ replaceAllText: { containsText: { text: 'gone', matchCase: true }, replaceText: '' } }] });
  // When Google does not report counts or a revision.
  const quiet = make(t, { routes: { ['POST docs.googleapis.com/v1/documents/' + DOC + ':batchUpdate']: { body: { replies: [{ replaceAllText: {} }] } } } });
  assert.deepEqual(await quiet.google.replaceInDoc(DOC, 'a', 'b'), { changed: 0 });
  assert.deepEqual(await quiet.google.appendDoc(DOC, 'x'), { revisionId: null });
});

test('sheets: info and reads, then RAW writes, appends and clears with encoded ranges', async t => {
  const base = 'sheets.googleapis.com/v4/spreadsheets/' + DOC;
  const grid = Array.from({ length: 250 }, (_, row) => Array.from({ length: 30 }, (_, col) => (col === 0 ? row : `r${row}c${col}`)));
  const { google, fake } = make(t, { routes: {
    ['GET ' + base]: { body: { properties: { title: 'Budget' }, sheets: [
      { properties: { title: 'Sheet1', gridProperties: { rowCount: 1000, columnCount: 26 } } },
      { properties: { title: 'Notes\nx' } }] } },
    ['GET ' + base + '/values/Sheet1!A1%3AC2']: { body: { range: 'Sheet1!A1:C2', values: [['a', 1, true], ['d']] } },
    ['GET ' + base + '/values/A1%3AZZ300']: { body: { values: grid } },
    ['GET ' + base + '/values/B1%3AB2']: { body: {} },
    [`PUT ${base}/values/'Budget%202027'!B2%3AC3`]: { body: { updatedCells: 4, updatedRange: '\'Budget 2027\'!B2:C3' } },
    ['POST ' + base + '/values/Sheet1!A%3AC:append']: { body: { updates: { updatedRange: 'Sheet1!A12:C12' } } },
    [`POST ${base}/values/'Q1%20(draft)'!A1:append`]: { body: {} },
    ['POST ' + base + '/values/Sheet1!A2%3AB3:clear']: { body: { clearedRange: 'Sheet1!A2:B3' } },
    ['POST ' + base + '/values/Sheet1!C5:clear']: { body: {} }
  } });
  assert.deepEqual(await google.sheetInfo(DOC), { title: 'Budget', sheets: [{ title: 'Sheet1', rows: 1000, cols: 26 }, { title: 'Notes x', rows: 0, cols: 0 }] });
  assert.equal(fake.apiRequests()[0].url, `https://${base.replace('/spreadsheets/', '/spreadsheets/')}?fields=properties.title,sheets.properties(title,gridProperties)`);
  // Reads: the range Google reports, cells as strings, at most 200 rows x 26 columns.
  assert.deepEqual(await google.readRange(DOC, 'Sheet1!A1:C2'), { range: 'Sheet1!A1:C2', values: [['a', '1', 'true'], ['d']] });
  assert.equal(fake.apiRequests()[1].url, `https://${base}/values/Sheet1!A1%3AC2?valueRenderOption=FORMATTED_VALUE`);
  assert.equal(fake.apiRequests()[1].method, 'GET');
  const big = await google.readRange(DOC, 'A1:ZZ300');
  assert.equal(big.range, 'A1:ZZ300');
  assert.equal(big.values.length, 200);
  assert.equal(big.values[0].length, 26);
  assert.equal(big.values[199][25], 'r199c25');
  assert.equal(big.values[199][0], '199');
  assert.deepEqual(await google.readRange(DOC, 'B1:B2'), { range: 'B1:B2', values: [] });
  // Writes are RAW, so a typed "=IMPORTDATA(...)" stays text.
  const written = await google.writeRange(DOC, "'Budget 2027'!B2:C3", [['=IMPORTDATA("http://x")', 'b'], [3, false]]);
  assert.deepEqual(written, { updatedCells: 4 });
  const put = fake.apiRequests().find(item => item.method === 'PUT');
  assert.equal(put.url, `https://${base}/values/'Budget%202027'!B2%3AC3?valueInputOption=RAW`);
  assert.deepEqual(put.json, { range: "'Budget 2027'!B2:C3", values: [['=IMPORTDATA("http://x")', 'b'], ['3', 'false']] });
  assert.ok(!put.url.includes('USER_ENTERED'));
  // Append a row.
  assert.deepEqual(await google.appendRow(DOC, 'Sheet1!A:C', ['x', 'y', 'z']), { updatedRange: 'Sheet1!A12:C12' });
  const append = fake.apiRequests().find(item => item.url.includes(':append?') && item.url.includes('Sheet1'));
  assert.equal(append.method, 'POST');
  assert.equal(append.url, `https://${base}/values/Sheet1!A%3AC:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`);
  assert.deepEqual(append.json, { values: [['x', 'y', 'z']] });
  assert.deepEqual(await google.appendRow(DOC, "'Q1 (draft)'!A1", ['only']), { updatedRange: '' });
  assert.equal(fake.apiRequests().at(-1).url, `https://${base}/values/'Q1%20(draft)'!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`);
  // Clear.
  assert.deepEqual(await google.clearRange(DOC, 'Sheet1!A2:B3'), { clearedRange: 'Sheet1!A2:B3' });
  const clear = fake.apiRequests().at(-1);
  assert.equal(clear.url, `https://${base}/values/Sheet1!A2%3AB3:clear`);
  assert.equal(clear.method, 'POST');
  assert.deepEqual(clear.json, {});
  assert.deepEqual(await google.clearRange(DOC, 'Sheet1!C5'), { clearedRange: 'Sheet1!C5' });
});

test('slides: read, add, delete and replace send exactly the requests Google expects', async t => {
  const base = 'slides.googleapis.com/v1/presentations/' + DOC;
  const { google, fake } = make(t, { routes: {
    ['GET ' + base]: { body: { title: 'Deck', revisionId: 'p-1', slides: [
      { objectId: 'slide_one', pageElements: [{ shape: { text: { textElements: [{ textRun: { content: 'Intro\n' } }] } } }] },
      { objectId: 'slide_two', pageElements: [{ shape: {} }] }] } },
    ['POST ' + base + ':batchUpdate']: () => {
      const sent = fake.requests.at(-1).json.requests[0];
      return { body: sent.replaceAllText ? { replies: [{ replaceAllText: { occurrencesChanged: 2 } }] } : { replies: [{}] } };
    }
  } });
  assert.deepEqual(await google.readSlides(DOC), { title: 'Deck', revisionId: 'p-1', slides: [
    { n: 1, objectId: 'slide_one', text: 'Intro' }, { n: 2, objectId: 'slide_two', text: '' }] });
  assert.equal(fake.apiRequests()[0].url, `https://${base}`);
  // Add a slide: one batch, new IDs for the slide and both placeholders, text inserted into each.
  const added = await google.addSlide(DOC, { title: 'Next steps', body: 'Ship it\nThen rest', revisionId: 'p-1' });
  const request = fake.apiRequests()[1];
  assert.equal(request.url, `https://${base}:batchUpdate`);
  assert.equal(request.method, 'POST');
  const [create, insertTitle, insertBody] = request.json.requests;
  const idPattern = /^wa[a-z0-9]{20}$/;
  assert.match(added.objectId, idPattern);
  assert.deepEqual(Object.keys(added), ['objectId']);
  assert.equal(create.createSlide.objectId, added.objectId);
  assert.deepEqual(create.createSlide.slideLayoutReference, { predefinedLayout: 'TITLE_AND_BODY' });
  const [titleMap, bodyMap] = create.createSlide.placeholderIdMappings;
  assert.deepEqual(titleMap.layoutPlaceholder, { type: 'TITLE', index: 0 });
  assert.deepEqual(bodyMap.layoutPlaceholder, { type: 'BODY', index: 0 });
  assert.match(titleMap.objectId, idPattern);
  assert.match(bodyMap.objectId, idPattern);
  assert.equal(new Set([added.objectId, titleMap.objectId, bodyMap.objectId]).size, 3);
  assert.deepEqual(insertTitle, { insertText: { objectId: titleMap.objectId, text: 'Next steps' } });
  assert.deepEqual(insertBody, { insertText: { objectId: bodyMap.objectId, text: 'Ship it\nThen rest' } });
  assert.equal(request.json.requests.length, 3);
  assert.deepEqual(request.json.writeControl, { requiredRevisionId: 'p-1' });
  // Two slides never share an ID.
  const second = await google.addSlide(DOC, { title: 'Again' });
  assert.notEqual(second.objectId, added.objectId);
  const noBody = fake.apiRequests()[2].json;
  assert.equal(noBody.requests.length, 2);
  assert.ok(!('writeControl' in noBody));
  assert.equal(noBody.requests[1].insertText.text, 'Again');
  // Delete.
  assert.deepEqual(await google.deleteSlide(DOC, 'slide_two', { revisionId: 'p-2' }), {});
  assert.deepEqual(fake.apiRequests()[3].json, { requests: [{ deleteObject: { objectId: 'slide_two' } }], writeControl: { requiredRevisionId: 'p-2' } });
  await google.deleteSlide(DOC, 'slide_one');
  assert.deepEqual(fake.apiRequests()[4].json, { requests: [{ deleteObject: { objectId: 'slide_one' } }] });
  // Replace.
  assert.deepEqual(await google.replaceInSlides(DOC, '2026', '2027', { revisionId: 'p-3' }), { changed: 2 });
  assert.deepEqual(fake.apiRequests()[5].json, { requests: [{ replaceAllText: { containsText: { text: '2026', matchCase: true }, replaceText: '2027' } }],
    writeControl: { requiredRevisionId: 'p-3' } });
  assert.equal(fake.apiRequests()[5].url, `https://${base}:batchUpdate`);
});

test('docText and slideTexts read realistic Google documents', () => {
  const run = content => ({ textRun: { content } });
  const cell = (...paragraphs) => ({ content: paragraphs.map(text => ({ paragraph: { elements: [run(text)] } })) });
  const document = { body: { content: [
    { sectionBreak: {} },
    { paragraph: { elements: [run('Project '), run('plan\n')] } },
    { paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: 'img' } }, run('Intro text\n')] } },
    { table: { tableRows: [
      { tableCells: [cell('Name\n'), cell('Qty\n')] },
      { tableCells: [cell('Apples\n'), cell('3\n', 'dozen\n')] }] } },
    { paragraph: { elements: [run('Bye\n')] } }] } };
  assert.equal(docText(document), 'Project plan\nIntro text\nName | Qty\nApples | 3 dozen\nBye\n');
  assert.equal(docText({}), '');
  assert.equal(docText(null), '');
  assert.equal(docText({ body: { content: [{ paragraph: { elements: [{}] } }] } }), '');

  const shape = (...runs) => ({ shape: { text: { textElements: [{}, ...runs.map(run)] } } });
  const slide = { objectId: 'g1', pageElements: [
    shape('Quarterly plan\n'),
    shape('Ship v2\n', 'Fix bugs\n'),
    { shape: { shapeType: 'RECTANGLE' } },
    { shape: { text: { textElements: [{ textRun: { content: '  \n' } }] } } },
    { table: { tableRows: [{ tableCells: [{ text: { textElements: [run('A\n')] } }, { text: { textElements: [run('B\n')] } }] }] } },
    { elementGroup: { children: [shape('Grouped\n')] } },
    { image: {} }] };
  assert.equal(slideTexts(slide), 'Quarterly plan / Ship v2 Fix bugs / A / B / Grouped');
  assert.equal(slideTexts({}), '');
  assert.equal(slideTexts({ pageElements: [shape('x'.repeat(900))] }), `${'x'.repeat(499)}…`);
  assert.equal([...slideTexts({ pageElements: [shape('x'.repeat(500))] })].length, 500);
  assert.equal(slideTexts({ pageElements: [shape('x'.repeat(500))] }), 'x'.repeat(500));
});

test('limits and bad input are refused before any request', async t => {
  const { google, fake } = make(t);
  const refuse = async (promise, pattern) => assert.match(await failure(promise), pattern);
  const sheetId = DOC, REV = 'rev';
  // IDs and ranges.
  await refuse(google.fileInfo('short'), /not a Google file ID/);
  await refuse(google.readDoc(`${DOC}/../x`), /not a Google file ID/);
  await refuse(google.sheetInfo('a b'.repeat(10)), /not a Google file ID/);
  await refuse(google.readSlides(undefined), /not a Google file ID/);
  await refuse(google.readRange(sheetId, 'A1&x=1'), /not a range/);
  await refuse(google.readRange(sheetId, "'It's'!A1"), /not a range/);
  await refuse(google.writeRange(sheetId, 'nope', [['a']]), /not a range/);
  await refuse(google.appendRow(sheetId, `${'x'.repeat(150)}!A1`, ['a']), /not a range/);
  await refuse(google.clearRange(sheetId, 'Sheet1!'), /not a range/);
  await refuse(google.deleteSlide(DOC, 'bad id!'), /not a slide ID/);
  await refuse(google.deleteSlide(DOC, 'abc'), /not a slide ID/);
  // Text lengths: find 1-500, replace and append 0-20000, title 1-200, body 0-5000.
  await refuse(google.replaceInDoc(DOC, '', 'x'), /text to find is empty/);
  await refuse(google.replaceInDoc(DOC, 'x'.repeat(501), 'y'), /text to find is too long/);
  await refuse(google.replaceInDoc(DOC, 'a', 'y'.repeat(20001)), /replacement text is too long/);
  await refuse(google.replaceInSlides(DOC, '', 'x'), /text to find is empty/);
  await refuse(google.replaceInSlides(DOC, 'x'.repeat(501), 'y'), /too long/);
  await refuse(google.replaceInSlides(DOC, 'a', 'y'.repeat(20001)), /too long/);
  await refuse(google.appendDoc(DOC, 'x'.repeat(20001)), /text is too long/);
  await refuse(google.appendDoc(DOC, 42), /must be text/);
  await refuse(google.addSlide(DOC, { title: '' }), /slide title is empty/);
  await refuse(google.addSlide(DOC, { title: 'x'.repeat(201) }), /slide title is too long/);
  await refuse(google.addSlide(DOC, { title: 'ok', body: 'x'.repeat(5001) }), /slide text is too long/);
  await refuse(google.addSlide(DOC), /slide title/);
  // Sheet shapes: a row at most 26 cells, a write at most 200 x 26, each cell at most 5000 characters.
  await refuse(google.appendRow(sheetId, 'A1', Array(27).fill('x')), /too many cells/);
  await refuse(google.appendRow(sheetId, 'A1', []), /at least one cell/);
  await refuse(google.appendRow(sheetId, 'A1', 'not a row'), /at least one cell/);
  await refuse(google.appendRow(sheetId, 'A1', ['x'.repeat(5001)]), /cell is too long/);
  await refuse(google.appendRow(sheetId, 'A1', [{ nested: true }]), /text or a number/);
  await refuse(google.writeRange(sheetId, 'A1:Z201', Array(201).fill(['x'])), /too many rows/);
  await refuse(google.writeRange(sheetId, 'A1:Z2', [Array(27).fill('x')]), /too many cells/);
  await refuse(google.writeRange(sheetId, 'A1', [['x'.repeat(5001)]]), /cell is too long/);
  await refuse(google.writeRange(sheetId, 'A1', []), /nothing to write/);
  await refuse(google.writeRange(sheetId, 'A1', 'x'), /nothing to write/);
  await refuse(google.writeRange(sheetId, 'A1', ['x']), /at least one cell/);
  await refuse(google.appendDoc(DOC, 'x', { revisionId: 'r'.repeat(201) }), /revision ID/);
  await refuse(google.deleteSlide(DOC, 'slide_one', { revisionId: 5 }), /revision ID/);
  assert.equal(fake.requests.length, 0);
  // The limits themselves are allowed.
  const ok = make(t, { routes: {
    ['POST docs.googleapis.com/v1/documents/' + DOC + ':batchUpdate']: { body: { replies: [{}] } },
    ['POST slides.googleapis.com/v1/presentations/' + DOC + ':batchUpdate']: { body: { replies: [{}] } },
    ['PUT sheets.googleapis.com/v4/spreadsheets/' + DOC + '/values/A1%3AZ200']: { body: { updatedCells: 5200 } }
  } });
  await ok.google.replaceInDoc(DOC, 'x'.repeat(500), 'y'.repeat(20000), { revisionId: REV });
  await ok.google.appendDoc(DOC, 'x'.repeat(20000));
  await ok.google.addSlide(DOC, { title: 'x'.repeat(200), body: 'y'.repeat(5000) });
  assert.deepEqual(await ok.google.writeRange(DOC, 'A1:Z200', Array.from({ length: 200 }, () => Array(26).fill('x'.repeat(5000)))), { updatedCells: 5200 });
  assert.equal(ok.fake.apiRequests().length, 4);
});
