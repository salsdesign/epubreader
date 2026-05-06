import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId); 
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export async function loginWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    console.error('Login failed', error);
    throw error;
  }
}

export async function testConnection() {
  try {
    // Only test if signed in, as the rule requires isSignedIn()
    if (auth.currentUser) {
      await getDocFromServer(doc(db, 'test', 'connection'));
      console.log("Firebase connection verified.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    } else {
      // Permission errors here are expected if not logged in or if path is restricted
      console.debug("Connection test skipped or restricted", error);
    }
  }
}
