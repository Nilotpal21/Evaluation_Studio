/**
 * DialPad — 4x3 DTMF keypad grid.
 *
 * Renders digits 1-9, *, 0, # with sub-labels.
 * Calls onPress(key) for each button tap.
 */

interface DialPadProps {
  onPress: (key: string) => void;
}

const KEYS = [
  { digit: '1', sub: '' },
  { digit: '2', sub: 'ABC' },
  { digit: '3', sub: 'DEF' },
  { digit: '4', sub: 'GHI' },
  { digit: '5', sub: 'JKL' },
  { digit: '6', sub: 'MNO' },
  { digit: '7', sub: 'PQRS' },
  { digit: '8', sub: 'TUV' },
  { digit: '9', sub: 'WXYZ' },
  { digit: '*', sub: '' },
  { digit: '0', sub: '+' },
  { digit: '#', sub: '' },
] as const;

export function DialPad({ onPress }: DialPadProps) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {KEYS.map(({ digit, sub }) => (
        <button
          key={digit}
          type="button"
          onClick={() => onPress(digit)}
          className="flex flex-col items-center justify-center h-14 rounded-lg
            bg-background-subtle hover:bg-background-muted active:bg-accent/10
            text-foreground transition-default select-none"
        >
          <span className="text-lg font-medium leading-tight">{digit}</span>
          {sub && <span className="text-[10px] text-muted leading-tight">{sub}</span>}
        </button>
      ))}
    </div>
  );
}
