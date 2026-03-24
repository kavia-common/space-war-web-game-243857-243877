import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  window.localStorage.clear();
});

test('renders start screen and prompts for player name when none is saved', () => {
  render(<App />);

  expect(screen.getByRole('dialog', { name: /start screen/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/player name/i)).toBeInTheDocument();

  // Start Game should not be available until a name is saved.
  expect(screen.queryByRole('button', { name: /start game/i })).not.toBeInTheDocument();
});

test('stores player name and allows starting the game', () => {
  render(<App />);

  fireEvent.change(screen.getByLabelText(/player name/i), { target: { value: 'Ace' } });
  fireEvent.click(screen.getByRole('button', { name: /save name/i }));

  // Name should persist
  expect(window.localStorage.getItem('spacewar.playerName.v1')).toBe('Ace');

  // Start Game is available after name is set.
  fireEvent.click(screen.getByRole('button', { name: /start game/i }));

  // HUD should always exist; and should show player.
  expect(screen.getByTestId('hud-score')).toBeInTheDocument();
  expect(screen.getByTestId('hud-lives')).toBeInTheDocument();
  expect(screen.getByTestId('hud-difficulty')).toBeInTheDocument();
  expect(screen.getByTestId('hud-player')).toHaveTextContent('Ace');

  // Start screen should be gone after starting.
  expect(screen.queryByRole('dialog', { name: /start screen/i })).not.toBeInTheDocument();
});

test('loads saved player name from localStorage and shows Start Game immediately', () => {
  window.localStorage.setItem('spacewar.playerName.v1', 'NovaPilot');

  render(<App />);

  expect(screen.getByRole('dialog', { name: /start screen/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /start game/i })).toBeInTheDocument();
  expect(screen.getByTestId('hud-player')).toHaveTextContent('NovaPilot');
});

test('canvas is present and accessible after starting', () => {
  render(<App />);

  fireEvent.change(screen.getByLabelText(/player name/i), { target: { value: 'Ace' } });
  fireEvent.click(screen.getByRole('button', { name: /save name/i }));
  fireEvent.click(screen.getByRole('button', { name: /start game/i }));

  expect(screen.getByRole('img', { name: /space war game canvas/i })).toBeInTheDocument();
});

test('leaderboard screen shows local scores and allows returning back to start', () => {
  window.localStorage.setItem(
    'spacewar.scores.v1',
    JSON.stringify([
      { player: 'Zed', score: 4200, timeAliveSec: 21.3, at: '2025-01-02T03:04:05.000Z' },
      { player: 'Ace', score: 3100, timeAliveSec: 15.7, at: '2025-01-03T03:04:05.000Z' }
    ])
  );

  render(<App />);

  // Open leaderboard from HUD
  fireEvent.click(screen.getByRole('button', { name: /leaderboard/i }));

  expect(screen.getByRole('dialog', { name: /leaderboard screen/i })).toBeInTheDocument();
  expect(screen.getByRole('table', { name: /leaderboard table/i })).toBeInTheDocument();

  // Rows should contain player names and formatted scores
  expect(screen.getByText('Zed')).toBeInTheDocument();
  expect(screen.getByText('Ace')).toBeInTheDocument();
  expect(screen.getByText('4,200')).toBeInTheDocument();
  expect(screen.getByText('3,100')).toBeInTheDocument();

  // Back returns to start screen
  fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
  expect(screen.getByRole('dialog', { name: /start screen/i })).toBeInTheDocument();
});
