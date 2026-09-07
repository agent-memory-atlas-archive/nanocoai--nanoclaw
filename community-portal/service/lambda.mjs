import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createApp } from './app.mjs';
import { registryIdentity } from './identity.mjs';
import { dynamoStore } from './store.mjs';
import { kmsSigner } from './kms.mjs';
import { catalog } from './catalog.mjs';
import { dynamoAccountPerks } from './account-perks.mjs';
import { lambdaSlack } from './slack.mjs';

let appPromise;
async function productionApp() {
  const required = ['PORTAL_ORIGIN', 'CELL_ORIGIN', 'PERKS_TABLE', 'REGISTRY_TABLE', 'SLACK_TABLE', 'SIGNING_KEY_ID'];
  for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);
  if (!process.env.PORTAL_ORIGIN.startsWith('https://')) throw new Error('PORTAL_ORIGIN must use HTTPS');
  let apiKey;
  if (process.env.WORKOS_CLIENT_ID && process.env.WORKOS_API_KEY_PARAMETER) {
    const ssm = new SSMClient({});
    apiKey = (await ssm.send(new GetParameterCommand({ Name: process.env.WORKOS_API_KEY_PARAMETER, WithDecryption: true }))).Parameter.Value;
  }
  return createApp({
    origin: process.env.PORTAL_ORIGIN, cellOrigin: process.env.CELL_ORIGIN,
    store: await dynamoStore(process.env.PERKS_TABLE), identity: await registryIdentity(process.env.REGISTRY_TABLE, process.env.REGISTRY_SERVICE_FUNCTION),
    accountPerks: dynamoAccountPerks({ registryTable: process.env.REGISTRY_TABLE, slackTable: process.env.SLACK_TABLE }),
    slackManage: process.env.SLACK_SERVICE_FUNCTION ? lambdaSlack(process.env.SLACK_SERVICE_FUNCTION) : undefined,
    signer: kmsSigner(process.env.SIGNING_KEY_ID), demo: false,
    catalog: catalog(), adapters: {}, globalDailyLimit: 0,
    workos: { clientId: process.env.WORKOS_CLIENT_ID, apiKey },
  });
}

export function albHandler(getApp) {
  return async event => {
    const app = await getApp();
    if (event.source === 'aws.events' && event['detail-type'] === 'Scheduled Event') {
      await app.service.drain(); return { ok: true };
    }
    if (!event.requestContext?.elb) throw new Error('Unsupported invocation');
    const headers = new Headers();
    const source = event.multiValueHeaders || Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k, [v]]));
    for (const [key, values] of Object.entries(source)) headers.set(key, values.join(key.toLowerCase() === 'cookie' ? '; ' : ', '));
    // Never derive redirects or cookie scope from a user-controlled Host header.
    const url = new URL(event.path, process.env.PORTAL_ORIGIN);
    const query = event.multiValueQueryStringParameters || Object.fromEntries(Object.entries(event.queryStringParameters || {}).map(([k, v]) => [k, [v]]));
    // ALB leaves query keys/values URL-encoded. Preserve them exactly once;
    // URL.searchParams in the app performs the decoding, including OAuth state.
    url.search = Object.entries(query).flatMap(([key, values]) => values.map(value => `${key}=${value}`)).join('&');
    const request = new Request(url, { method: event.httpMethod, headers,
      ...(!['GET', 'HEAD'].includes(event.httpMethod) ? { body: event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : event.body || '' } : {}),
    });
    // ALB is configured in append mode; only its final address is trusted.
    request.clientIp = headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
    const response = await app.fetch(request);
    const multiValueHeaders = {};
    for (const [key, value] of response.headers) if (key !== 'set-cookie') multiValueHeaders[key] = [value];
    const cookies = response.headers.getSetCookie(); if (cookies.length) multiValueHeaders['set-cookie'] = cookies;
    return { statusCode: response.status, multiValueHeaders, body: await response.text(), isBase64Encoded: false };
  };
}
export const handler = albHandler(() => appPromise ??= productionApp().catch(error => { appPromise = undefined; throw error; }));
