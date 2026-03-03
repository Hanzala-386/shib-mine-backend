import { initializeApp } from 'firebase/app';
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  sendEmailVerification,
  onAuthStateChanged,
  type User as FirebaseUser,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyDQnt9_QENqlHtMprocQnJVQkB-4IyBgjg',
  authDomain: 'shib-mine.firebaseapp.com',
  projectId: 'shib-mine',
  storageBucket: 'shib-mine.firebasestorage.app',
  messagingSenderId: '1032738643319',
  appId: '1:1032738643319:web:057ba2235420353b2a1572',
  measurementId: 'G-5TYK49Z19W',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

export {
  auth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  firebaseSignOut,
  sendEmailVerification,
  onAuthStateChanged,
  type FirebaseUser,
};
