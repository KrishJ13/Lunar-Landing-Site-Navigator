export default function MissionDateFields({ dates, onChange }) {
  return (
    <>
      <label>
        <span>Mission start (UTC)</span>
        <input type="datetime-local" required value={dates.start}
          onInput={(event) => onChange({ ...dates, start: event.currentTarget.value })}
          onChange={(event) => onChange({ ...dates, start: event.currentTarget.value })} />
      </label>
      <label>
        <span>Mission end (UTC)</span>
        <input type="datetime-local" required value={dates.end}
          onInput={(event) => onChange({ ...dates, end: event.currentTarget.value })}
          onChange={(event) => onChange({ ...dates, end: event.currentTarget.value })} />
      </label>
    </>
  )
}
