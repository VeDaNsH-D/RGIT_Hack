import { useEffect } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import AuthPage from './components/AuthPage'
import './App.css'

function HomeRoute() {
  const { hash } = useLocation()
  // Preserve links shared before path-based routing was introduced.
  if (hash === '#signup') return <Navigate to="/signup" replace />
  if (hash === '#signin') return <Navigate to="/signin" replace />
  return <LandingPage />
}

function ScrollToDestination() {
  const { pathname, hash } = useLocation()

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = hash && document.getElementById(decodeURIComponent(hash.slice(1)))
      if (target) target.scrollIntoView()
      else window.scrollTo(0, 0)
    })
    return () => cancelAnimationFrame(frame)
  }, [pathname, hash])

  return null
}

function NotFoundPage() {
  return (
    <main className="not-found-page">
      <span className="eyebrow">404 / PAGE NOT FOUND</span>
      <h1>This page isn’t here.</h1>
      <p>Head back to the home page to find what you need.</p>
      <Link className="button button-blue button-orange" to="/">Back to home</Link>
    </main>
  )
}

export default function App() {
  return (
    <>
      <ScrollToDestination />
      <Routes>
        <Route path="/" element={<HomeRoute />} />
        <Route path="/signup" element={<AuthPage key="register" mode="register" />} />
        <Route path="/signin" element={<AuthPage key="login" mode="login" />} />
        <Route path="/login" element={<Navigate to="/signin" replace />} />
        <Route path="/register" element={<Navigate to="/signup" replace />} />
        <Route path="/auth" element={<Navigate to="/signup" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  )
}
