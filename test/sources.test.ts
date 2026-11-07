import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.ts';
import { ascMessages, ascReviewsDiff, ascToMessages, phasedDiff, unresolvedDiff, verifyAsc } from '../src/sources/asc.ts';
import { easToMessages } from '../src/sources/eas.ts';
import { ingestToMessage, verifyIngest } from '../src/sources/ingest.ts';
import { playDiff, playReviewsDiff } from '../src/sources/play.ts';
import { ascKey } from './keys.ts';

const app: AppConfig = { id: 'myapp', name: 'My App' };

void test('signatures: Apple and Standard Webhooks test vectors', () => {
  // https://developer.apple.com/documentation/appstoreconnectapi/configuring-webhook-notifications
  const apple = 'hmacsha256=7f062172b01cb00b53ca068614674a3d982a34062a0f5d37687d5e3377e54657';
  assert.ok(verifyAsc(Buffer.from('Hello, World!'), apple, 'This is my secret'));
  // standard-webhooks python test suite
  const h = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: '1614265330', signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' };
  assert.ok(verifyIngest(Buffer.from('{"test": 2432232314}'), h, 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 1614265330));
});

void test('EAS: failed build and successful submission map to messages', () => {
  const [b] = easToMessages({
    id: 'b1', buildDetailsPageUrl: 'https://expo.dev/b1', platform: 'android', status: 'errored',
    metadata: { appVersion: '1.4.2', appBuildVersion: '57' }, error: { message: 'Gradle build failed', errorCode: 'X' },
  }, app);
  assert.deepEqual([b.type, b.title], ['build.failed', 'Android build failed: My App 1.4.2 (57)']);
  const [s] = easToMessages({ id: 's1', submissionDetailsPageUrl: 'https://expo.dev/s1', platform: 'ios', status: 'finished' }, app);
  assert.deepEqual([s.type, s.title], ['submit.succeeded', 'iOS submission to App Store Connect succeeded: My App']);
});

void test("ASC: Apple's example payload maps to a rejection", () => {
  const event = {
    data: {
      type: 'appStoreVersionAppVersionStateUpdated', id: '7c813492', version: 1,
      attributes: { newValue: 'REJECTED', oldValue: 'IN_REVIEW', timestamp: '2025-04-16T05:00:52.745Z' },
      relationships: { instance: { data: { type: 'appStoreVersions', id: 'ad7e6298' } } },
    },
  };
  const [m] = ascToMessages(event, app, { version: '1.4.2', platform: 'IOS', appleAppId: '123' });
  assert.deepEqual([m.type, m.title], ['appreview.rejected', 'iOS rejected: My App 1.4.2']);
});

void test('ASC: version state changes map to review and release events', () => {
  const types = (oldValue: string, newValue: string) =>
    ascToMessages({ data: { type: 'appStoreVersionAppVersionStateUpdated', id: 'v1', attributes: { oldValue, newValue } } }, app).map((m) => m.type);
  assert.deepEqual(types('PREPARE_FOR_SUBMISSION', 'WAITING_FOR_REVIEW'), ['appreview.submitted']);
  assert.deepEqual(types('IN_REVIEW', 'PENDING_DEVELOPER_RELEASE'), ['appreview.approved']);
  assert.deepEqual(types('IN_REVIEW', 'READY_FOR_DISTRIBUTION'), ['appreview.approved', 'release.live']);
  assert.deepEqual(types('PENDING_DEVELOPER_RELEASE', 'READY_FOR_DISTRIBUTION'), ['release.live']);
  assert.deepEqual(types('WAITING_FOR_REVIEW', 'DEVELOPER_REJECTED'), ['appreview.withdrawn']);
  assert.deepEqual(types('PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW'), []);
});

void test("ASC: Apple's external TestFlight example maps to a beta review approval, with the build looked up", async (t) => {
  const event = {
    data: {
      type: 'buildBetaDetailExternalBuildStateUpdated', id: '4a9eacca',
      attributes: { newExternalBuildState: 'BETA_APPROVED', oldExternalBuildState: 'IN_BETA_REVIEW', timestamp: '2025-04-16T05:00:52.745Z' },
      relationships: { instance: { data: { type: 'buildBetaDetails', id: 'ad7e6298' } } },
    },
  };
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    Response.json(url.includes('/buildBetaDetails/ad7e6298/relationships/build') ? { data: { type: 'builds', id: 'b57' } }
      : { data: { attributes: { version: '57' }, relationships: { app: { data: { id: '123' } } } }, included: [{ type: 'preReleaseVersions', attributes: { version: '1.4.2', platform: 'IOS' } }] }));
  const api = { issuerId: 'i', keyId: 'k', privateKey: ascKey };
  const [m] = await ascMessages(event, app, api);
  assert.deepEqual([m.type, m.title, m.links?.[0].url], ['betareview.approved', 'iOS build approved in TestFlight review: My App 1.4.2 (57)', 'https://appstoreconnect.apple.com/apps/123/testflight']);
});

void test('ASC: TestFlight feedback carries the comment, tester, device and screenshots', () => {
  const event = { data: { type: 'betaFeedbackScreenshotSubmissionCreated', id: 'f1', relationships: { instance: { data: { type: 'betaFeedbackScreenshotSubmissions', id: 'AD8J' } } } } };
  const feedback = { comment: 'Login button does nothing', email: 'kim@acme.com', device: 'iPhone15,2', os: '18.4', screenshots: ['https://x/1.png'] };
  const [m] = ascToMessages(event, app, { version: '1.4.2 (57)', platform: 'IOS', appleAppId: '123', feedback });
  assert.deepEqual([m.type, m.title, m.body, m.actor, m.links?.map((l) => l.label)],
    ['testing.feedback', 'iOS TestFlight feedback: My App 1.4.2 (57)', 'Login button does nothing', 'kim@acme.com', ['Open TestFlight', 'Screenshot 1']]);
  // Without ascApi it still notifies, so ascMessages doesn't drop it before the lookup.
  assert.equal(ascToMessages({ data: { ...event.data, type: 'betaFeedbackCrashSubmissionCreated' } }, app)[0].type, 'testing.crash');
});

void test('Play: first poll is a baseline, then a state change notifies', () => {
  const rel = (state: string) => [{ releaseName: '57 (1.4.2)', releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`, activeArtifacts: [{ versionCode: '57' }] }];
  const play = { ...app, play: { packageName: 'com.acme.myapp', tracks: ['production'] } };
  const first = playDiff(undefined, rel('IN_REVIEW'), play, 'production');
  assert.equal(first.messages.length, 0);
  const second = playDiff(first.next, rel('PUBLISHED'), play, 'production');
  assert.deepEqual(second.messages.map((m) => [m.type, m.title]), [['release.live', 'Android live on Google Play: My App 57 (1.4.2)']]);
});

void test('reviews: the first poll is a baseline, then newer reviews notify with severity by rating', () => {
  const asc = { ...app, asc: { secret: 's', appId: '123', reviews: true } };
  const review = (id: string, createdDate: string, rating: number) => ({ id, attributes: { rating, title: 'Crashes', body: 'On login', createdDate } });
  const first = ascReviewsDiff(undefined, [review('r1', '2025-05-01T10:00:00-07:00', 5)], asc);
  assert.equal(first.messages.length, 0);
  // Later than r1 once the offsets are applied, though it sorts earlier as text.
  const second = ascReviewsDiff(first.next, [review('r2', '2025-05-01T18:30:00+01:00', 1), review('r1', '2025-05-01T10:00:00-07:00', 5)], asc);
  assert.deepEqual(second.messages.map((m) => [m.title, m.severity, m.body]), [['★☆☆☆☆ App Store review: My App', 'warning', 'Crashes\nOn login']]);

  const play = { ...app, play: { packageName: 'com.acme.myapp', tracks: ['production'], reviews: true } };
  const p = (seconds: string) => [{ reviewId: 'g1', authorName: 'Kim', comments: [{ userComment: { text: 'Great\tLove it', starRating: 4, lastModified: { seconds } } }] }];
  const base = playReviewsDiff(undefined, p('100'), play);
  assert.equal(playReviewsDiff(base.next, p('100'), play).messages.length, 0);
  assert.deepEqual(playReviewsDiff(base.next, p('200'), play).messages.map((m) => [m.title, m.severity, m.body]), [['★★★★☆ Google Play review: My App', 'success', 'Great\nLove it']]);
});

void test('rollouts: phased release changes after a baseline', () => {
  const asc = { ...app, asc: { secret: 's', appId: '123' } };
  const live = (phasedReleaseState: string, currentDayNumber: number) => ({
    data: [{ id: 'v1', attributes: { versionString: '1.4.2', platform: 'IOS' }, relationships: { appStoreVersionPhasedRelease: { data: { id: 'p1' } } } }],
    included: [{ type: 'appStoreVersionPhasedReleases', id: 'p1', attributes: { phasedReleaseState, currentDayNumber } }],
  });
  const ios = phasedDiff(undefined, live('ACTIVE', 2), asc);
  assert.equal(ios.messages.length, 0);
  assert.deepEqual(phasedDiff(ios.next, live('ACTIVE', 3), asc).messages.map((m) => [m.type, m.title]), [['rollout.updated', 'iOS phased release at 5% (day 3 of 7): My App 1.4.2']]);
  assert.deepEqual(phasedDiff(ios.next, live('PAUSED', 2), asc).messages.map((m) => m.type), ['rollout.paused']);

});

void test('ASC: a new unresolved submission notifies, unless its version was rejected', () => {
  const asc = { ...app, asc: { secret: 's', appId: '123' } };
  const sub = (id: string, versionId?: string) => ({ id, attributes: { platform: 'IOS' }, relationships: { appStoreVersionForReview: { data: versionId ? { id: versionId } : null } } });
  const base = unresolvedDiff(undefined, { data: [sub('s1')] }, asc);
  assert.equal(base.messages.length, 0);
  const r = { data: [sub('s1'), sub('s2'), sub('s3', 'v3')], included: [{ type: 'appStoreVersions', id: 'v3', attributes: { versionString: '1.5.0', appVersionState: 'REJECTED' } }] };
  assert.deepEqual(unresolvedDiff(base.next, r, asc).messages.map((m) => [m.type, m.id]), [['appreview.unresolved', 'asc:submission:s2']]);
});

void test('ingest: a valid event becomes a message, a javascript: link is rejected', () => {
  const m = ingestToMessage('msg_1', { type: 'update.published', title: 'OTA update published' });
  assert.deepEqual(typeof m === 'object' && [m.type, m.title], ['update.published', 'OTA update published']);
  assert.match(ingestToMessage('x', { type: 'a.b', title: 't', links: [{ label: 'x', url: 'javascript:alert(1)' }] }) as string, /links/);
});

void test("ingest: link URLs are percent-encoded, so the targets' URL caps count what they send", () => {
  const m = ingestToMessage('x', { type: 'a.b', title: 't', links: [{ label: 'x', url: ' https://expo.dev/a b€' }] });
  assert.equal(typeof m === 'object' && m.links?.[0].url, 'https://expo.dev/a%20b%E2%82%AC');
});
