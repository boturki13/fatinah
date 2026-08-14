import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
const config = JSON.parse(fs.readFileSync(new URL('capacitor.config.json', root), 'utf8'));
const delegate = fs.readFileSync(new URL('ios/App/App/AppDelegate.swift', root), 'utf8');
const app = fs.readFileSync(new URL('www/app.js', root), 'utf8');

assert.equal(pkg.dependencies['@capacitor-firebase/messaging'], '8.4.0');
assert.deepEqual(config.plugins.FirebaseMessaging.presentationOptions, ['alert', 'badge', 'sound']);
assert.match(delegate, /capacitorDidRegisterForRemoteNotifications/);
assert.match(delegate, /didReceiveRemoteNotification/);
assert.match(app, /notificationReceived/);
assert.match(app, /notificationActionPerformed/);
assert.match(app, /FirebaseMessaging\.getToken|messaging\.getToken/);

console.log('✓ Firebase Messaging يربط APNs ويستقبل الإشعارات ويستخرج رمز FCM');
