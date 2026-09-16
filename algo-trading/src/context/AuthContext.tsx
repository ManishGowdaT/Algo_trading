import React, { createContext, useContext, useState, useEffect } from 'react';

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

const configuredApiBase = import.meta.env.VITE_API_BASE ?? import.meta.env.VITE_API_URL;
const API_BASE = `${configuredApiBase
    ? `${configuredApiBase.replace(/\/+$/, '')}${configuredApiBase.replace(/\/+$/, '').endsWith('/api/v1') ? '' : '/api/v1'}`
    : 'http://localhost:5000/api/v1'}/users`;

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchMe = async () => {
            try {
                const token = localStorage.getItem('jwt');
                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                if (token) {
                    headers['Authorization'] = `Bearer ${token}`;
                }

                const res = await fetch(`${API_BASE}/me`, {
                    headers,
                    credentials: 'include'
                });
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
        await fetch(`${API_BASE}/logout`, {
            method: 'POST',
            credentials: 'include'
        });
        localStorage.removeItem('jwt');
        setUser(null);
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
