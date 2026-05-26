import { auth } from './firebase';

export async function trackVisit() {
  // Simple session check to avoid spamming logs on every refresh
  const sessionKey = 'vetto_last_visit';
  const lastVisit = localStorage.getItem(sessionKey);
  const now = Date.now();
  
  if (lastVisit && now - parseInt(lastVisit) < 1000 * 60 * 30) {
    return; // Don't track if visited in last 30 mins
  }
  localStorage.setItem(sessionKey, now.toString());
  
  // Fire and forget geolocation to avoid blocking
  const getGeo = async () => {
    try {
      const geoResponse = await fetch('https://ipapi.co/json/');
      if (geoResponse.ok) {
        return await geoResponse.json();
      }
    } catch {}
    return null;
  };

  const geoPromise = getGeo();

  try {
    const geo = await geoPromise;
    let location = null;
    if (geo) {
      location = `${geo.city}, ${geo.region}, ${geo.country_name}`;
    }

    const payload = {
      uid: auth.currentUser?.uid || 'anonymous',
      email: auth.currentUser?.email || 'anonymous',
      userAgent: navigator.userAgent,
      referrer: document.referrer || 'Direct',
      screen: `${window.screen.width}x${window.screen.height}`,
      location,
    };

    await fetch("/api/analytics", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

  } catch (error) {
    console.warn('Analytics capture incomplete:', error);
  }
}
