import { db, auth } from './firebase';
import { doc, setDoc, updateDoc, increment, serverTimestamp, getDoc } from 'firebase/firestore';

export async function trackVisit() {
  // Simple session check to avoid spamming logs on every refresh
  const sessionKey = 'vetto_last_visit';
  const lastVisit = localStorage.getItem(sessionKey);
  const now = Date.now();
  
  if (lastVisit && now - parseInt(lastVisit) < 1000 * 60 * 30) {
    return; // Don't track if visited in last 30 mins
  }
  localStorage.setItem(sessionKey, now.toString());

  const logId = `visit_${now}_${Math.random().toString(36).substring(2, 9)}`;
  const logRef = doc(db, 'analytics_v1', logId);
  
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

  const visitorData: any = {
    uid: auth.currentUser?.uid || 'anonymous',
    email: auth.currentUser?.email || 'anonymous',
    userAgent: navigator.userAgent,
    referrer: document.referrer || 'Direct',
    screen: `${window.screen.width}x${window.screen.height}`,
    timestamp: serverTimestamp(),
  };

  try {
    const geo = await geoPromise;
    if (geo) {
      visitorData.location = `${geo.city}, ${geo.region}, ${geo.country_name}`;
    }

    // Individual visit log
    await setDoc(logRef, visitorData);

    // Global counter
    const statsRef = doc(db, 'stats', 'global');
    await setDoc(statsRef, {
      activeUsers: increment(1),
      updatedAt: serverTimestamp(),
    }, { merge: true });

  } catch (error) {
    console.warn('Analytics capture incomplete:', error);
  }
}
