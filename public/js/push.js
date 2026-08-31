function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Push notifications are not supported in this browser.');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      alert('Notification permission was not granted.');
      return;
    }
    const keyRes = await fetch('/notifications/vapid-public-key');
    const { key } = await keyRes.json();
    if (!key) {
      alert('Push notifications are not configured on the server yet.');
      return;
    }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    }
    await fetch('/notifications/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub)
    });
    const btn = document.getElementById('enable-push-btn');
    if (btn) { btn.textContent = '🔔 Notifications Enabled'; btn.disabled = true; }
  } catch (e) {
    console.error(e);
    alert('Could not enable notifications: ' + e.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('enable-push-btn');
  if (btn) btn.addEventListener('click', enablePush);
});
