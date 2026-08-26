function orientationActions(orientation = 1) {
  switch (Number(orientation) || 1) {
    case 2: return ['flop'];
    case 3: return ['rotate'];
    case 4: return ['rotate', 'flop'];
    case 5: return ['rotate', 'flop'];
    case 6: return ['rotate'];
    case 7: return ['rotate', 'flop'];
    case 8: return ['rotate'];
    default: return [];
  }
}

function orientationTransform(pipeline, orientation = 1) {
  const operations = orientationActions(orientation);
  if (!operations.length) return pipeline;
  let result = pipeline;
  if (operations[0] === 'rotate') result = result.rotate(orientation === 5 || orientation === 7 ? 90 : orientation === 8 ? 270 : orientation === 3 || orientation === 4 ? 180 : 90);
  if (operations.includes('flop')) result = result.flop();
  return result;
}

module.exports = { orientationActions, orientationTransform };
