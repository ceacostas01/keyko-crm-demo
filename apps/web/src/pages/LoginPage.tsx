import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth';
import { Icon } from '../components/Icon';
import { Button, Field, Input } from '../components/ui';

export function LoginPage() {
  const { login, user } = useAuth();
  const location = useLocation();
  const isDev = import.meta.env.DEV;
  const [email, setEmail] = useState(isDev ? 'demo@keyko.local' : '');
  const [password, setPassword] = useState(isDev ? 'Demo1234!' : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'No se pudo iniciar sesión. Intenta de nuevo.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <section className="login-art">
        <img
          className="login-logo"
          src="/branding/keyko-logo.jpg"
          alt="Keyko Pet Shop & Grooming"
        />

        <div className="login-art-copy">
          <span className="login-eyebrow">CRM para pet grooming</span>
          <h2>Todo el cuidado de Keyko, en un solo lugar.</h2>
          <p>
            Mascotas, citas, ventas y conversaciones de WhatsApp con una lectura
            clara del día. Pensado para el mostrador y para el celular.
          </p>
          <div className="login-badges" aria-label="Funciones principales">
            <span>
              <Icon name="calendar" size={15} /> Agenda
            </span>
            <span>
              <Icon name="paw" size={15} /> Fichas
            </span>
            <span>
              <Icon name="chat" size={15} /> WhatsApp
            </span>
          </div>
        </div>

        <p className="login-note">
          Un administrador por negocio · Zona horaria America/Bogota
        </p>
      </section>

      <section className="login-panel">
        <div className="login-mobile-brand">
          <img
            src="/branding/keyko-logo.jpg"
            alt="Keyko Pet Shop & Grooming"
          />
        </div>

        <form className="login-box" onSubmit={onSubmit}>
          <div>
            <span className="login-eyebrow">Bienvenida</span>
            <h1>Entrar</h1>
            <p className="muted small" style={{ marginTop: 4 }}>
              Usa la cuenta de tu negocio.
            </p>
          </div>

          {error ? <div className="login-error">{error}</div> : null}

          <Field label="Correo" htmlFor="email">
            <Input
              id="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>

          <Field label="Contraseña" htmlFor="password">
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>

          <Button type="submit" variant="primary" block loading={busy}>
            Entrar
          </Button>

          {isDev ? (
            <div className="login-hint">
              Datos de la demo local: <strong>demo@keyko.local</strong> ·{' '}
              <strong>Demo1234!</strong>
            </div>
          ) : null}
        </form>
      </section>
    </div>
  );
}
