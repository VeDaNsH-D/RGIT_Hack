import React from 'react';
import { AgoraRoom } from './components/AgoraRoom';
import './App.css';

function App() {
  return (
    <main style={{ minHeight: '100vh', background: '#0a0f1d', paddingBottom: '3rem' }}>
      <AgoraRoom />
    </main>
  );
}

export default App;
