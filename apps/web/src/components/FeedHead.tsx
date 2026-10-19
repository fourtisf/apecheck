/** FEED_HEAD: column titles of the verdict table (hidden on phones). */
export function FeedHead() {
  return (
    <div className="tr th" role="row">
      <span>Score</span>
      <span>Project</span>
      <span>Narrative</span>
      <span>Coin</span>
      <span className="num c-mc">MC</span>
      <span className="num c-since">Since check</span>
      <span className="num c-age">Age</span>
    </div>
  );
}
