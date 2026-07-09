function getEthicsColor(score) {
  if (score === null || score === undefined || score === '') return '#94a3b8';
  const s = Number(score);
  if (s <= 50) {
    const ratio = s / 50;
    return `rgb(${Math.round(220 + (245 - 220) * ratio)}, ${Math.round(38 + (158 - 38) * ratio)}, ${Math.round(38 + (11 - 38) * ratio)})`;
  } else {
    const ratio = (s - 50) / 50;
    return `rgb(${Math.round(245 + (21 - 245) * ratio)}, ${Math.round(158 + (128 - 158) * ratio)}, ${Math.round(11 + (61 - 11) * ratio)})`;
  }
}
console.log('Score 10:', getEthicsColor(10));
console.log('Score 100:', getEthicsColor(100));
console.log('Score null:', getEthicsColor(null));
console.log('Score undefined:', getEthicsColor(undefined));
console.log('Score "":', getEthicsColor(''));
console.log('Score "unknown":', getEthicsColor('unknown'));
