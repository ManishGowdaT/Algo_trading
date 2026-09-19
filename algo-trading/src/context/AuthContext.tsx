import React, { createContext, useContext, useState, useEffect } from 'react';
import { API_BASE as API_ROOT } from '../config/apiBase';

interface User {
    _id: string;
    email: string;
}

interface AuthContextType {
    user: User | null;
    loading: boolean;
    login: (email: string, password: string) => Promise<void>;
    register: (email: string, password: string, confirmPassword: string) => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const API_BASE = `${API_ROOT}/users`;

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchMe = async () => {
            try {
                const token = localStorage.getItem('jwt');
                const fetchCurrentUser = (accessToken: string | null) => {
                    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
                    return fetch(`${API_BASE}/me`, { headers, credentials: 'include' });
                };

                let res = await fetchCurrentUser(token);
                if (res.status === 401) {
                    const refresh = await fetch(`${API_BASE}/refresh`, {
                        method: 'POST',
                        credentials: 'include'
                    });
                    if (refresh.ok) {
                        const refreshData = await refresh.json();
                        if (refreshData.token) localStorage.setItem('jwt', refreshData.token);
                        res = await fetchCurrentUser(refreshData.token || null);
                    }
                }
                if (res.ok) {
                    const data = await res.json();
                    setUser(data.data.user);
                }
            } catch (err) {
                console.error('Failed to fetch user:', err);
            } finally {
                setLoading(false);
            }
        };
        fetchMe();
    }, []);

    const login = async (email: string, password: string) => {
        const res = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
            credentials: 'include'
        });

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.message || 'Login failed');
        }

        const data = await res.json();
        if (data.token) {
            localStorage.setItem('jwt', data.token);
        }
        setUser(data.data.user);
    };

    const register = async (email: string, password: string, confirmPassword: string) => {
        const res = await fetch(`${API_BASE}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, confirmPassword }),
            credentials: 'include'
        });

        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.message || 'Registration failed');
        }

        if (data.token) {
            localStorage.setItem('jwt', data.token);
        }
        setUser(data.data.user);
    };

    const logout = async () => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 5000);
        try {
            await fetch(`${API_BASE}/logout`, {
                method: 'POST',
                credentials: 'include',
                signal: controller.signal,
            });
        } catch (err) {
            // Logout remains local-first even when the server is unavailable.
            console.warn('Server logout request failed; clearing local session.', err);
        } finally {
            window.clearTimeout(timeout);
            localStorage.removeItem('jwt');
            setUser(null);
        }
    };

    return (
        <AuthContext.Provider value={{ user, loading, login, register, logout }}>
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
