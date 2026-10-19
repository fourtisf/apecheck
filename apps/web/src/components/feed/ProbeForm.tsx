'use client';
import { useRef, useState, type FormEvent } from 'react';
import { detectChipLabel } from '@apecheck/core';
import { useActions } from '../Actions';

/** The hero form (#probe): type chip that follows the input, "Check · 1 credit". */
export function ProbeForm() {
  const { startCheck } = useActions();
  const [value, setValue] = useState('');
  const busy = useRef(false);
  const chip = detectChipLabel(value);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    try {
      await startCheck(value);
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
        <button className="btn-run" type="submit">
          Check <small>1 credit</small>
        </button>
      </label>
    </form>
  );
}
