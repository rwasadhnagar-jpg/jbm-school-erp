const express = require('express');
const router = express.Router();
const db = require('../db');
const webpush = require('web-push');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:jbmpschool@gmail.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

(async () => {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh VARCHAR(255) NOT NULL,
      auth VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY user_endpoint (user_id, endpoint(255))
    )`);
  } catch (e) { console.error('push_subscriptions init:', e.message); }
})();

async function sendPush(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await db.query('DELETE FROM push_subscriptions WHERE id=?', [sub.id]);
    } else {
      console.error('push send error:', err.message);
    }
  }
}

async function sendPushToUser(userId, payload) {
  const [subs] = await db.query('SELECT * FROM push_subscriptions WHERE user_id=?', [userId]);
  for (const sub of subs) await sendPush(sub, payload);
}

async function sendPushToRole(role, payload) {
  const [subs] = await db.query(
    'SELECT ps.* FROM push_subscriptions ps JOIN users u ON ps.user_id=u.id WHERE u.role=?',
    [role]
  );
  for (const sub of subs) await sendPush(sub, payload);
}

router.get('/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || '' });
});

router.post('/subscribe', async (req, res) => {
  try {
    const userId = req.session.user && req.session.user.id;
    if (!userId) return res.status(401).json({ error: 'Not logged in' });
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) return res.status(400).json({ error: 'Invalid subscription' });
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE p256dh=VALUES(p256dh), auth=VALUES(auth)`,
      [userId, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

module.exports = { router, sendPushToUser, sendPushToRole };
