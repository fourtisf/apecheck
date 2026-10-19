'use client';
import { useRef, useState, type FormEvent } from 'react';
import { detectChipLabel } from '@apecheck/core';
import { useActions } from '../Actions';
import { useMe } from '../Me';

/**
 * The hero form (#probe): type chip that follows the input, "Check · 1 credit". Max viewers also get a "Private"
 * toggle (POST /v1/checks private: true keeps the check off the public feed).
 */
export function ProbeForm() {
  const { startCheck } = useActions();
  const { me } = useMe();
  const [value, setValue] = useState('');
  const [priv, setPriv] = useState(false);
  const busy = useRef(false);
  const chip = detectChipLabel(value);
  const canPrivate = me?.tier === 'max';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    try {
      await startCheck(value, { private: canPrivate && priv });
    } finally {
      busy.current = false;
    }
  }

  return (
    <form id="probe" noValidate onSubmit={onSubmit}>
      <label className="probe-field">
        <span className={`probe-type${chip.on ? ' on' : ''}`} id="typeChip">
          {chip.text}
        </span>
        <input
          id="target"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="Contract address, X post or link"
          autoComplete="off"
          spellCheck={false}
          aria-label="What to check"
          maxLength={2048}
        />
        {canPrivate ? (
          <button
            className="probe-priv"
            id="privToggle"
            type="button"
            aria-pressed={priv}
            data-tip="Keep this check off the public feed"
            onClick={e => {
              e.preventDefault();
              setPriv(p => !p);
            }}
          >
            Private
          </button>
        ) : null}
        <button className="btn-run" type="submit">
          Check <small>1 credit</small>
        </button>
      </label>
    </form>
  );
}
