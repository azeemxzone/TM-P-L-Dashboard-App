import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { auth, db, googleAuthProvider } from '../firebase';
import { AllowedUsersDoc, UserRole, AllowedUserRecord } from '../types';
import { handleFirestoreError, OperationType } from '../lib/firestoreErrors';

const SEED_EMAIL = 'mak44641@gmail.com';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  isAuthorized: boolean;
  isAdmin: boolean;
  isViewer: boolean;
  userRole: UserRole | null;
  allowedDoc: AllowedUsersDoc | null;
  userList: AllowedUserRecord[];
  signInWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  addUser: (email: string, role: UserRole) => Promise<void>;
  updateUserRole: (email: string, role: UserRole) => Promise<void>;
  removeUser: (email: string) => Promise<void>;
  authError: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isViewer, setIsViewer] = useState(false);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [allowedDoc, setAllowedDoc] = useState<AllowedUsersDoc | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // Derive unified user records list
  const userList: AllowedUserRecord[] = React.useMemo(() => {
    if (!allowedDoc) return [{ email: SEED_EMAIL, role: 'admin' }];

    const result: AllowedUserRecord[] = [];
    const emails = allowedDoc.emails || [];
    const rolesMap = allowedDoc.roles || {};
    const admins = (allowedDoc.admins || []).map((e) => e.toLowerCase().trim());

    // Merge explicitly registered users
    const existingMap = new Map<string, AllowedUserRecord>();
    if (Array.isArray(allowedDoc.users)) {
      allowedDoc.users.forEach((u) => {
        existingMap.set(u.email.toLowerCase().trim(), u);
      });
    }

    emails.forEach((emailStr) => {
      const email = emailStr.toLowerCase().trim();
      const existing = existingMap.get(email);
      let role: UserRole = 'viewer';
      if (email === SEED_EMAIL.toLowerCase() || admins.includes(email) || rolesMap[email] === 'admin') {
        role = 'admin';
      } else if (rolesMap[email] === 'viewer') {
        role = 'viewer';
      }

      result.push({
        email,
        role,
        addedAt: existing?.addedAt || allowedDoc.updatedAt || new Date().toISOString(),
        addedBy: existing?.addedBy || allowedDoc.updatedBy || 'admin',
      });
    });

    // Ensure root seed email is present
    if (!result.some((u) => u.email === SEED_EMAIL.toLowerCase())) {
      result.unshift({
        email: SEED_EMAIL.toLowerCase(),
        role: 'admin',
        addedAt: new Date().toISOString(),
        addedBy: 'system',
      });
    }

    return result;
  }, [allowedDoc]);

  // Seed or initialize allowed users doc
  const ensureAllowedUsersSeeded = async (currentUser: User) => {
    const docRef = doc(db, 'allowedUsers', 'default');
    try {
      const snap = await getDoc(docRef);
      if (!snap.exists()) {
        const initialDoc: AllowedUsersDoc = {
          emails: [SEED_EMAIL.toLowerCase()],
          admins: [SEED_EMAIL.toLowerCase()],
          roles: {
            [SEED_EMAIL.toLowerCase()]: 'admin',
          },
          users: [
            {
              email: SEED_EMAIL.toLowerCase(),
              role: 'admin',
              addedAt: new Date().toISOString(),
              addedBy: currentUser.email || 'system',
            },
          ],
          updatedAt: new Date().toISOString(),
          updatedBy: currentUser.email || 'system',
        };
        await setDoc(docRef, initialDoc);
        setAllowedDoc(initialDoc);
      } else {
        const data = snap.data() as AllowedUsersDoc;
        const emails = (data.emails || []).map((e) => e.toLowerCase().trim());
        const admins = (data.admins || []).map((e) => e.toLowerCase().trim());
        const roles = data.roles || {};

        let needsUpdate = false;
        if (!emails.includes(SEED_EMAIL.toLowerCase())) {
          emails.push(SEED_EMAIL.toLowerCase());
          needsUpdate = true;
        }
        if (!admins.includes(SEED_EMAIL.toLowerCase())) {
          admins.push(SEED_EMAIL.toLowerCase());
          needsUpdate = true;
        }
        if (roles[SEED_EMAIL.toLowerCase()] !== 'admin') {
          roles[SEED_EMAIL.toLowerCase()] = 'admin';
          needsUpdate = true;
        }

        if (needsUpdate) {
          const updated: AllowedUsersDoc = {
            ...data,
            emails,
            admins,
            roles,
            updatedAt: new Date().toISOString(),
          };
          await setDoc(docRef, updated);
          setAllowedDoc(updated);
        } else {
          setAllowedDoc(data);
        }
      }
    } catch (err) {
      // If offline or initializing, onSnapshot will pick up the doc when connection is established
      console.warn('Initial seeding waiting for online connection:', err instanceof Error ? err.message : err);
    }
  };

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      setAuthError(null);

      if (!firebaseUser) {
        setUser(null);
        setIsAuthorized(false);
        setIsAdmin(false);
        setIsViewer(false);
        setUserRole(null);
        setAllowedDoc(null);
        setLoading(false);
        return;
      }

      // Check if user's token can be refreshed; if securetoken API is disabled, handle gracefully
      try {
        await firebaseUser.getIdToken();
      } catch (tokenErr) {
        const errStr = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
        if (errStr.includes('token-service-api') || errStr.includes('securetoken.googleapis.com')) {
          console.warn('Token Service API disabled on project 116053236246');
          setAuthError(
            'Google Cloud Token Service API is disabled in project continual-medium-b61jg (116053236246). Enable it at https://console.developers.google.com/apis/api/securetoken.googleapis.com/overview?project=116053236246 then sign in again.'
          );
          try {
            await signOut(auth);
          } catch {
            // Ignore signout error
          }
          setUser(null);
          setIsAuthorized(false);
          setIsAdmin(false);
          setIsViewer(false);
          setUserRole(null);
          setAllowedDoc(null);
          setLoading(false);
          return;
        }
      }

      setUser(firebaseUser);

      const email = firebaseUser.email?.toLowerCase().trim() || '';
      const isOwner = email === SEED_EMAIL.toLowerCase();

      try {
        await ensureAllowedUsersSeeded(firebaseUser);
      } catch (e) {
        console.warn('Seed verification warning:', e);
      }

      const docRef = doc(db, 'allowedUsers', 'default');
      const unsubscribeDoc = onSnapshot(
        docRef,
        (snap) => {
          if (snap.exists()) {
            const data = snap.data() as AllowedUsersDoc;
            setAllowedDoc(data);

            const allowedEmails = (data.emails || []).map((e) => e.toLowerCase().trim());
            const adminEmails = (data.admins || []).map((e) => e.toLowerCase().trim());
            const rolesMap = data.roles || {};

            let currentRole: UserRole | null = null;
            if (isOwner || adminEmails.includes(email) || rolesMap[email] === 'admin') {
              currentRole = 'admin';
            } else if (allowedEmails.includes(email) || rolesMap[email] === 'viewer') {
              currentRole = 'viewer';
            }

            if (currentRole) {
              setIsAuthorized(true);
              setIsAdmin(currentRole === 'admin');
              setIsViewer(currentRole === 'viewer');
              setUserRole(currentRole);
            } else {
              setIsAuthorized(false);
              setIsAdmin(false);
              setIsViewer(false);
              setUserRole(null);
            }
          } else {
            // Document doesn't exist yet, seed owner is allowed admin
            setIsAuthorized(isOwner);
            setIsAdmin(isOwner);
            setIsViewer(!isOwner);
            setUserRole(isOwner ? 'admin' : null);
          }
          setLoading(false);
        },
        (error) => {
          console.error('AllowedUsers snapshot error:', error);
          if (isOwner) {
            setIsAuthorized(true);
            setIsAdmin(true);
            setIsViewer(false);
            setUserRole('admin');
          } else {
            setIsAuthorized(false);
            setIsAdmin(false);
            setIsViewer(false);
            setUserRole(null);
          }
          setLoading(false);
        }
      );

      return () => {
        unsubscribeDoc();
      };
    });

    return () => unsubscribeAuth();
  }, []);

  const signInWithGoogle = async () => {
    try {
      setAuthError(null);
      const cred = await signInWithPopup(auth, googleAuthProvider);
      await cred.user.getIdToken();
    } catch (err: unknown) {
      console.error('Google sign in error:', err);
      const msg = err instanceof Error ? err.message : 'Sign in failed';
      if (msg.includes('token-service-api') || msg.includes('securetoken.googleapis.com')) {
        setAuthError(
          'Google Cloud Token Service API is disabled in project continual-medium-b61jg (116053236246). Enable it at https://console.developers.google.com/apis/api/securetoken.googleapis.com/overview?project=116053236246 then sign in again.'
        );
      } else {
        setAuthError(msg);
      }
      throw err;
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      setUser(null);
      setIsAuthorized(false);
      setIsAdmin(false);
      setIsViewer(false);
      setUserRole(null);
      setAllowedDoc(null);
    } catch (err: unknown) {
      console.error('Sign out error:', err);
    }
  };

  const saveAllowedUsersDoc = async (newDoc: AllowedUsersDoc) => {
    const docRef = doc(db, 'allowedUsers', 'default');
    try {
      await setDoc(docRef, newDoc);
      setAllowedDoc(newDoc);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'allowedUsers/default');
    }
  };

  const addUser = async (newEmail: string, role: UserRole) => {
    const email = newEmail.trim().toLowerCase();
    if (!email) return;

    const emails = Array.from(new Set([...(allowedDoc?.emails || []), email]));
    const roles: Record<string, UserRole> = { ...(allowedDoc?.roles || {}), [email]: role };
    const admins = (allowedDoc?.admins || []).filter((e) => e.toLowerCase() !== email);
    if (role === 'admin' || email === SEED_EMAIL.toLowerCase()) {
      admins.push(email);
    }

    const currentUsers = allowedDoc?.users || [];
    const updatedUsers = [
      ...currentUsers.filter((u) => u.email.toLowerCase() !== email),
      {
        email,
        role,
        addedAt: new Date().toISOString(),
        addedBy: user?.email || 'admin',
      },
    ];

    await saveAllowedUsersDoc({
      emails,
      admins: Array.from(new Set(admins)),
      roles,
      users: updatedUsers,
      updatedAt: new Date().toISOString(),
      updatedBy: user?.email || 'admin',
    });
  };

  const updateUserRole = async (targetEmail: string, role: UserRole) => {
    const email = targetEmail.trim().toLowerCase();
    if (email === SEED_EMAIL.toLowerCase() && role !== 'admin') {
      throw new Error('Root seed owner cannot be demoted from admin.');
    }

    const roles: Record<string, UserRole> = { ...(allowedDoc?.roles || {}), [email]: role };
    let admins = (allowedDoc?.admins || []).filter((e) => e.toLowerCase() !== email);
    if (role === 'admin') {
      admins.push(email);
    }
    if (!admins.includes(SEED_EMAIL.toLowerCase())) {
      admins.push(SEED_EMAIL.toLowerCase());
    }

    const currentUsers = allowedDoc?.users || [];
    const updatedUsers = currentUsers.map((u) =>
      u.email.toLowerCase() === email ? { ...u, role } : u
    );

    await saveAllowedUsersDoc({
      emails: allowedDoc?.emails || [SEED_EMAIL.toLowerCase()],
      admins: Array.from(new Set(admins)),
      roles,
      users: updatedUsers,
      updatedAt: new Date().toISOString(),
      updatedBy: user?.email || 'admin',
    });
  };

  const removeUser = async (targetEmail: string) => {
    const email = targetEmail.trim().toLowerCase();
    if (email === SEED_EMAIL.toLowerCase()) {
      throw new Error('Root seed owner cannot be removed.');
    }

    const emails = (allowedDoc?.emails || []).filter((e) => e.toLowerCase() !== email);
    const admins = (allowedDoc?.admins || []).filter((e) => e.toLowerCase() !== email);
    const roles = { ...(allowedDoc?.roles || {}) };
    delete roles[email];
    const users = (allowedDoc?.users || []).filter((u) => u.email.toLowerCase() !== email);

    await saveAllowedUsersDoc({
      emails,
      admins,
      roles,
      users,
      updatedAt: new Date().toISOString(),
      updatedBy: user?.email || 'admin',
    });
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAuthorized,
        isAdmin,
        isViewer,
        userRole,
        allowedDoc,
        userList,
        signInWithGoogle,
        logout,
        addUser,
        updateUserRole,
        removeUser,
        authError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
