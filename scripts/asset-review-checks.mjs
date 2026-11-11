import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {setImmediate as flushAsync} from 'node:timers/promises';
import ts from 'typescript';
import {Observable, Subject, Subscription, of} from 'rxjs';
import {finalize} from 'rxjs/operators';

// Execute the actual component methods with a fake clock and isolated HTTP/modal collaborators.
const source = fs.readFileSync('src/app/services/connect-token/acl-dialog/acl-dialog.component.ts', 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true}
}).outputText;
let now = 0;
let nextTimer = 0;
const timers = new Map();
class Clock extends Date {static now() {return now;}}
const decorator = () => () => {};
const context = {
  exports: {}, Date: Clock, console,
  setInterval(callback, interval) {const id = ++nextTimer; timers.set(id, {callback, interval}); return id;},
  clearInterval(id) {timers.delete(id);},
  require(name) {
    if (name === '@angular/core') return {Component: decorator, Inject: decorator};
    if (name === 'rxjs') return {Subscription};
    if (name === 'rxjs/operators') return {finalize};
    if (name === '@app/utils/path') return {withUIBase: value => value};
    return {};
  }
};
vm.runInNewContext(javascript, context);
const Dialog = context.exports.ElementACLDialogComponent;
let checks = 0;
function test(name, run) {
  return Promise.resolve().then(run).then(() => {
    checks++;
    console.log(`PASS ${name}`);
  });
}
function fixture(seconds = 300, method = 'PUT', action = 'create') {
  now = 1000000;
  timers.clear();
  const status = new Subject();
  const creation = new Subject();
  const calls = {close: [], modal: [], notices: [], create: []};
  const http = {
    get: () => status,
    put: url => {calls.close.push(['PUT', url]); return of('ok');},
    delete: url => {calls.close.push(['DELETE', url]); return of('ok');},
    createConnectToken: (...args) => {calls.create.push(['create', args]); return creation;},
    exchangeConnectToken: (...args) => {calls.create.push(['exchange', args]); return creation;},
    adminConnectToken: (...args) => {calls.create.push(['admin', args]); return creation;}
  };
  const i18n = {t: async key => key, instant: key => key};
  const token = {
    expire_time: seconds, date_expired: new Date(now + seconds * 1000).toISOString(), from_ticket: 'ticket',
    from_ticket_info: {
      check_ticket_api: {method: 'GET', url: '/ticket/'},
      close_ticket_api: {method, url: '/ticket/close/'}, assignees: ['reviewer'], ticket_detail_page_url: '/ticket/'
    }
  };
  const dialog = new Dialog(
    {code: 'acl_review', tokenAction: action, error: {error: {detail: 'test'}}},
    i18n, http, {}, {success: msg => calls.notices.push(msg)}, {}, {},
    {close: value => calls.modal.push(value)}, {}
  );
  dialog.ngOnInit();
  const start = () => {dialog.onConfirmReview(); creation.next(token);};
  const poll = () => {
    const entry = [...timers.values()].find(item => item.interval === 3000);
    assert.ok(entry, 'polling timer exists');
    entry.callback();
  };
  const tick = milliseconds => {now += milliseconds; dialog.updateReviewCountdown();};
  return {dialog, token, calls, http, status, creation, start, poll, tick};
}

for (const seconds of [300, 600, 1000]) {
  await test(`token remaining time ${seconds}s, local countdown and timeout`, () => {
    const f = fixture(seconds); f.start();
    assert.equal(f.dialog.reviewRemainingSeconds, seconds);
    assert.equal(f.dialog.reviewProgress, 0);
    f.tick(seconds * 500);
    assert.equal(f.dialog.reviewProgress, 50);
    f.tick(seconds * 500);
    assert.equal(f.dialog.code, 'ticket_review_timeout');
    assert.equal(f.dialog.reviewProgress, 100);
    assert.equal(f.dialog.reviewRemainingTime, '0:00');
    assert.equal(f.calls.close.length, 1);
    assert.equal(f.calls.modal.length, 0);
    assert.equal(timers.size, 0);
    f.dialog.onModalCancel(); f.dialog.ngOnDestroy();
    assert.equal(f.calls.close.length, 1);
  });
}
for (const entry of ['button', 'mask', 'escape', 'x']) {
  await test(`${entry} cancels pending review once and closes`, () => {
    const f = fixture(); f.start();
    entry === 'button' ? f.dialog.onCancelWait() : f.dialog.onModalCancel();
    f.dialog.ngOnDestroy();
    assert.equal(f.calls.close.length, 1);
    assert.equal(f.calls.modal.length, 1);
    assert.equal(timers.size, 0);
  });
}
await test('before submission dismissal does not cancel a nonexistent ticket', () => {
  const f = fixture(); f.dialog.onModalCancel(); f.dialog.ngOnDestroy();
  assert.equal(f.calls.close.length, 0);
});
await test('countdown ticks do not make HTTP requests', () => {
  const f = fixture(); f.start();
  for (let i = 0; i < 10; i++) f.tick(1000);
  assert.equal(f.dialog.reviewRemainingSeconds, 290);
  assert.equal(f.status.observed, false);
  assert.equal(f.calls.close.length, 0);
  f.dialog.onCancelWait();
});
await test('absolute expiry fallback when remaining seconds are absent', () => {
  const f = fixture(); delete f.token.expire_time; f.start();
  assert.equal(f.dialog.reviewRemainingSeconds, 300);
  f.tick(301000);
  assert.equal(f.dialog.code, 'ticket_review_timeout');
});
await test('dismissal during modal closing still cancels late-created ticket', () => {
  const f = fixture(); f.dialog.onConfirmReview(); f.dialog.onModalCancel();
  f.creation.next(f.token);
  assert.equal(f.calls.close.length, 1);
  assert.equal(timers.size, 0);
});
await test('closing polling error screen also cancels pending ticket', () => {
  const f = fixture(); f.start(); f.poll();
  f.status.error({error: {detail: 'backend unavailable'}});
  f.dialog.closeDialog(); f.dialog.ngOnDestroy();
  assert.equal(f.calls.close.length, 1);
  assert.equal(timers.size, 0);
});
await test('service-account cancellation uses returned DELETE method', () => {
  const f = fixture(300, 'DELETE'); f.start(); f.dialog.onCancelWait();
  assert.deepEqual(f.calls.close, [['DELETE', '/ticket/close/']]);
});
await test('approved within lifetime connects without cancellation', async () => {
  const f = fixture(); f.start(); f.poll();
  f.status.next({status: {value: 'closed'}, state: {value: 'approved'}});
  await flushAsync();
  assert.equal(f.calls.modal[0], f.token);
  f.dialog.ngOnDestroy();
  assert.equal(f.calls.close.length, 0);
  assert.equal(timers.size, 0);
});
for (const state of ['rejected', 'closed']) {
  await test(`${state} stops timers without cancellation`, () => {
    const f = fixture(); f.start(); f.poll();
    f.status.next({status: {value: 'closed'}, state: {value: state}});
    assert.equal(f.dialog.code, `ticket_review_${state}`);
    f.dialog.onModalCancel(); f.dialog.ngOnDestroy();
    assert.equal(f.calls.close.length, 0);
    assert.equal(timers.size, 0);
  });
}
await test('expired approval response does not connect even before next timer tick', async () => {
  const f = fixture(); f.start(); f.poll(); now += 301000;
  f.status.next({status: {value: 'closed'}, state: {value: 'approved'}});
  await flushAsync();
  assert.equal(f.calls.modal.length, 0);
  assert.equal(f.dialog.code, 'ticket_review_timeout');
  assert.equal(f.calls.close.length, 1);
});
await test('late in-flight approval after timeout is ignored', async () => {
  const f = fixture(); f.start(); f.poll(); f.tick(301000);
  assert.equal(f.status.observed, false);
  f.status.next({status: {value: 'closed'}, state: {value: 'approved'}});
  await flushAsync();
  assert.equal(f.calls.modal.length, 0);
});
await test('approval translation resolving after timeout cannot connect', async () => {
  const f = fixture(); f.start(); f.poll();
  f.status.next({status: {value: 'closed'}, state: {value: 'approved'}});
  f.tick(301000); await flushAsync();
  assert.equal(f.calls.modal.length, 0);
  assert.equal(f.dialog.code, 'ticket_review_timeout');
});
await test('polling error retains timeout cancellation', () => {
  const f = fixture(); f.start(); f.poll();
  f.status.error({error: {detail: 'backend unavailable'}});
  assert.equal(f.dialog.code, 'other');
  f.tick(301000);
  assert.equal(f.dialog.code, 'ticket_review_timeout');
  assert.equal(f.calls.close.length, 1);
});
await test('pending creation completed after destruction cancels orphan ticket', () => {
  const f = fixture(); f.dialog.onConfirmReview(); f.dialog.onModalCancel(); f.dialog.ngOnDestroy();
  f.creation.next(f.token);
  assert.equal(f.calls.close.length, 1);
  assert.equal(timers.size, 0);
});
await test('zero remaining time immediately times out, keeping dialog open', () => {
  const f = fixture(0); f.start();
  assert.equal(f.calls.close.length, 1);
  assert.equal(f.calls.modal.length, 0);
  assert.equal(timers.size, 0);
});
for (const action of ['create', 'exchange', 'admin']) {
  await test(`${action} review response starts same countdown`, () => {
    const f = fixture(1000, 'PUT', action);
    if (action === 'admin') f.dialog.data.connectData = {direct: true};
    f.start();
    assert.equal(f.calls.create[0][0], action);
    assert.equal(f.dialog.reviewRemainingSeconds, 1000);
    f.dialog.onCancelWait();
  });
}
await test('cancellation response is not awaited before closing', () => {
  const f = fixture(); f.http.put = url => {f.calls.close.push(['PUT', url]); return new Observable(() => {});};
  f.start(); f.dialog.onCancelWait();
  assert.equal(f.calls.modal.length, 1);
});

const serviceSource = fs.readFileSync('src/app/services/connect-token/index.ts', 'utf8');
const serviceJS = ts.transpileModule(serviceSource, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true}
}).outputText;
const serviceContext = {exports: {}, require: name => name === '@angular/core' ? {Injectable: decorator} : {}};
vm.runInNewContext(serviceJS, serviceContext);
await test('modal cancellation callback delegates to component without disabling mask/Escape', () => {
  let options; const service = new serviceContext.exports.ConnectTokenService({}, {
    create(value) {options = value; return {afterClose: of(null)};}
  });
  service.handleError({}, () => {});
  let invoked = 0;
  assert.equal(options.nzOnCancel({onModalCancel() {invoked++; return false;}}), false);
  assert.equal(invoked, 1);
  assert.notEqual(options.nzMaskClosable, false);
  assert.notEqual(options.nzKeyboard, false);
});
console.log(`${checks} asset review checks passed.`);
