import { translate } from '../i18n.js';
import { SceneType } from '../model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;
const ROW_GAP = 40;
const COLUMN_GAP = 60;
const CONNECTOR_COLORS = ['#64748b', '#2563eb', '#059669', '#b45309', '#7c3aed', '#dc2626'];

export function computeSceneGraphLayout(project) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  if (!scenes.length) {
    return {
      positions: new Map(),
      orderedIds: [],
      rowCount: 0,
      columnCount: 0,
    };
  }

  const sceneById = new Map(scenes.map(scene => [scene.id, scene]));
  const adjacency = new Map();
  scenes.forEach(scene => {
    const targets = new Set();
    (scene.choices ?? []).forEach(choice => {
      const nextId = choice.nextSceneId;
      if (nextId && sceneById.has(nextId)) {
        targets.add(nextId);
      }
    });
    if (scene.autoNextSceneId && sceneById.has(scene.autoNextSceneId)) {
      targets.add(scene.autoNextSceneId);
    }
    adjacency.set(scene.id, Array.from(targets));
  });

  const startScene = scenes.find(scene => scene.type === SceneType.START) ?? scenes[0];
  const queue = [];
  const visited = new Set();
  const rowAssignments = new Map();
  const orderedIds = [];

  if (startScene) {
    queue.push({ id: startScene.id, depth: 0 });
  }

  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    rowAssignments.set(current.id, current.depth);
    orderedIds.push(current.id);

    const children = adjacency.get(current.id) ?? [];
    children.forEach(childId => {
      if (!visited.has(childId)) {
        queue.push({ id: childId, depth: current.depth + 1 });
      }
    });
  }

  let maxRow = 0;
  rowAssignments.forEach(row => {
    if (row > maxRow) maxRow = row;
  });

  const endScenes = scenes.filter(scene => scene.type === SceneType.END);
  let endingRow = null;
  if (endScenes.length) {
    const visitedEndRows = endScenes
      .map(scene => rowAssignments.get(scene.id))
      .filter(row => row !== undefined);
    let finalRow = maxRow;
    if (!visitedEndRows.length) {
      finalRow = maxRow + 1;
    } else {
      finalRow = Math.max(maxRow, ...visitedEndRows);
    }
    endScenes.forEach(scene => {
      const existing = rowAssignments.get(scene.id);
      if (existing !== undefined && existing < finalRow) {
        rowAssignments.set(scene.id, finalRow);
      } else if (!rowAssignments.has(scene.id)) {
        rowAssignments.set(scene.id, finalRow);
        orderedIds.push(scene.id);
      }
    });
    maxRow = Math.max(maxRow, finalRow);
    endingRow = maxRow;
  }

  scenes.forEach(scene => {
    if (!rowAssignments.has(scene.id)) {
      maxRow += 1;
      rowAssignments.set(scene.id, maxRow);
      orderedIds.push(scene.id);
    }
  });

  let uniqueRows = Array.from(new Set(rowAssignments.values())).sort((a, b) => a - b);
  if (endingRow !== null) {
    uniqueRows = uniqueRows.filter(row => row !== endingRow).concat(endingRow);
  }
  const rowRemap = new Map(uniqueRows.map((row, index) => [row, index]));
  const remappedEntries = [];
  rowAssignments.forEach((row, id) => {
    const remapped = rowRemap.get(row);
    if (remapped !== undefined) {
      remappedEntries.push([id, remapped]);
    }
  });
  rowAssignments.clear();
  remappedEntries.forEach(([id, row]) => {
    rowAssignments.set(id, row);
  });

  const rowBuckets = new Map();
  orderedIds.forEach(id => {
    const row = rowAssignments.get(id);
    if (row === undefined) return;
    if (!rowBuckets.has(row)) {
      rowBuckets.set(row, []);
    }
    const bucket = rowBuckets.get(row);
    bucket.push(id);
  });

  let columnCount = 0;
  const positions = new Map();
  rowBuckets.forEach((ids, row) => {
    ids.forEach((sceneId, column) => {
      positions.set(sceneId, { row, column });
    });
    if (ids.length > columnCount) {
      columnCount = ids.length;
    }
  });

  const rowCount = uniqueRows.length;

  return { positions, orderedIds, rowCount, columnCount };
}

export function renderGraph(hostEl, project, selectedId, onSelect) {
  hostEl.innerHTML = '';
  hostEl.classList.add('graph-host');

  const nodes = project.scenes || [];
  if (!nodes.length) {
    const empty = document.createElement('p');
    empty.className = 'graph-empty';
    empty.textContent = 'No scenes yet. Use “Add Scene” to begin.';
    hostEl.appendChild(empty);
    return;
  }
  const layout = computeSceneGraphLayout(project);
  const columnCount = layout.columnCount || 1;
  const width = Math.max(
    columnCount * (NODE_WIDTH + COLUMN_GAP) + COLUMN_GAP,
    320,
  );
  const height = layout.rowCount
    ? layout.rowCount * (NODE_HEIGHT + ROW_GAP) + ROW_GAP
    : 160;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'list');

  const defs = document.createElementNS(SVG_NS, 'defs');
  CONNECTOR_COLORS.forEach((color, index) => {
    const marker = document.createElementNS(SVG_NS, 'marker');
    marker.setAttribute('id', `graph-arrowhead-${index}`);
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('refX', '6.2');
    marker.setAttribute('refY', '3.5');
    marker.setAttribute('orient', 'auto');
    marker.setAttribute('markerUnits', 'strokeWidth');

    const markerPath = document.createElementNS(SVG_NS, 'path');
    markerPath.setAttribute('d', 'M 0 0 L 7 3.5 L 0 7 z');
    markerPath.setAttribute('class', 'graph-arrowhead');
    markerPath.setAttribute('fill', color);

    marker.appendChild(markerPath);
    defs.appendChild(marker);
  });
  svg.appendChild(defs);

  const connectorsGroup = document.createElementNS(SVG_NS, 'g');
  connectorsGroup.classList.add('graph-connectors');

  const edges = [];
  nodes.forEach(scene => {
    const sourcePosition = layout.positions.get(scene.id);
    if (!sourcePosition) return;
    const seenTargets = new Set();
    const addEdge = (targetId, className) => {
      if (!targetId || seenTargets.has(targetId)) return;
      const targetPosition = layout.positions.get(targetId);
      if (!targetPosition) return;
      seenTargets.add(targetId);
      edges.push({ sourceId: scene.id, targetId, className });
    };

    (scene.choices ?? []).forEach(choice => {
      addEdge(choice.nextSceneId, null);
    });

    if (scene.autoNextSceneId) {
      addEdge(scene.autoNextSceneId, 'is-auto-next');
    }
  });

  const outgoingEdges = new Map();
  const incomingEdges = new Map();
  edges.forEach(edge => {
    if (!outgoingEdges.has(edge.sourceId)) outgoingEdges.set(edge.sourceId, []);
    if (!incomingEdges.has(edge.targetId)) incomingEdges.set(edge.targetId, []);
    outgoingEdges.get(edge.sourceId).push(edge);
    incomingEdges.get(edge.targetId).push(edge);
  });

  const sourceColorIndex = new Map();
  layout.orderedIds.forEach((sceneId, index) => {
    sourceColorIndex.set(sceneId, index % CONNECTOR_COLORS.length);
  });
  const getNodeLeft = position => COLUMN_GAP + position.column * (NODE_WIDTH + COLUMN_GAP);
  const getNodeCenterX = position => getNodeLeft(position) + NODE_WIDTH / 2;
  const getPortX = (position, edgeIndex, edgeCount) => (
    getNodeLeft(position) + (NODE_WIDTH * (edgeIndex + 1)) / (edgeCount + 1)
  );
  const getSidePortX = (position, side, index = 0) => {
    const centerX = getNodeCenterX(position);
    const step = Math.min(48, NODE_WIDTH / 4);
    return centerX + side * step * (index + 1);
  };
  const getPositionSortValue = id => {
    const position = layout.positions.get(id);
    return position ? (position.column * 1000) + position.row : 0;
  };
  outgoingEdges.forEach(edgeList => {
    edgeList.sort((a, b) => getPositionSortValue(a.targetId) - getPositionSortValue(b.targetId));
  });
  incomingEdges.forEach(edgeList => {
    edgeList.sort((a, b) => getPositionSortValue(a.sourceId) - getPositionSortValue(b.sourceId));
  });
  const laneGroups = new Map();
  edges.forEach(edge => {
    const sourcePosition = layout.positions.get(edge.sourceId);
    const targetPosition = layout.positions.get(edge.targetId);
    if (!sourcePosition || !targetPosition) return;
    const key = `${sourcePosition.row}:${targetPosition.row}`;
    if (!laneGroups.has(key)) laneGroups.set(key, []);
    laneGroups.get(key).push(edge);
  });
  laneGroups.forEach(edgeList => {
    edgeList.sort((a, b) => {
      const sourceDiff = getPositionSortValue(a.sourceId) - getPositionSortValue(b.sourceId);
      return sourceDiff || getPositionSortValue(a.targetId) - getPositionSortValue(b.targetId);
    });
  });
  const createPath = (edge, pathData, colorIndex) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathData);
    path.classList.add('graph-connector');
    path.setAttribute('stroke', CONNECTOR_COLORS[colorIndex]);
    path.setAttribute('marker-end', `url(#graph-arrowhead-${colorIndex})`);
    if (edge.className) {
      path.classList.add(edge.className);
    }
    if (selectedId) {
      if (edge.sourceId === selectedId || edge.targetId === selectedId) {
        path.classList.add('graph-connector--related');
      } else {
        path.classList.add('graph-connector--dimmed');
      }
    }
    connectorsGroup.appendChild(path);
  };
  const getLaneY = (sourceY, targetY, edge, laneKey) => {
    const laneList = laneGroups.get(laneKey) ?? [edge];
    const laneIndex = Math.max(0, laneList.indexOf(edge));
    const gap = targetY - sourceY;
    if (gap <= 0) {
      return sourceY + ROW_GAP / 2 + laneIndex * 8;
    }
    const padding = Math.min(10, gap / 4);
    return sourceY + padding + ((gap - padding * 2) * (laneIndex + 1)) / (laneList.length + 1);
  };
  const createOrthogonalPathData = (sourceX, sourceY, targetX, targetY, laneY) => {
    const horizontal = targetX - sourceX;
    if (Math.abs(horizontal) < 4) {
      return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
    }
    const direction = Math.sign(horizontal);
    const verticalDown = Math.max(0, laneY - sourceY);
    const verticalIn = Math.max(0, targetY - laneY);
    const radius = Math.min(8, Math.abs(horizontal) / 2, verticalDown / 2, verticalIn / 2);
    return [
      `M ${sourceX} ${sourceY}`,
      `L ${sourceX} ${laneY - radius}`,
      `Q ${sourceX} ${laneY} ${sourceX + direction * radius} ${laneY}`,
      `L ${targetX - direction * radius} ${laneY}`,
      `Q ${targetX} ${laneY} ${targetX} ${laneY + radius}`,
      `L ${targetX} ${targetY}`,
    ].join(' ');
  };
  const createDirectPathData = (sourcePosition, sourceY, targetPosition, targetY) => {
    const sourceCenterX = getNodeCenterX(sourcePosition);
    const targetCenterX = getNodeCenterX(targetPosition);
    return `M ${sourceCenterX} ${sourceY} L ${targetCenterX} ${targetY}`;
  };
  const edgeRouting = new Map();
  outgoingEdges.forEach((sourceEdges, sourceId) => {
    const sourcePosition = layout.positions.get(sourceId);
    if (!sourcePosition) return;
    const sourceCenterX = getNodeCenterX(sourcePosition);
    const directCandidates = sourceEdges
      .map(edge => ({ edge, targetPosition: layout.positions.get(edge.targetId) }))
      .filter(item => (
        item.targetPosition
        && item.targetPosition.row > sourcePosition.row
        && Math.abs(getNodeCenterX(item.targetPosition) - sourceCenterX) <= 24
      ))
      .sort((a, b) => (
        Math.abs(getNodeCenterX(a.targetPosition) - sourceCenterX)
        - Math.abs(getNodeCenterX(b.targetPosition) - sourceCenterX)
      ));
    const directEdge = directCandidates[0]?.edge ?? null;
    if (directEdge) {
      edgeRouting.set(directEdge, { direct: true });
    }
    const remainingEdges = sourceEdges.filter(edge => edge !== directEdge);
    const leftEdges = [];
    const rightEdges = [];
    remainingEdges.forEach(edge => {
      const targetPosition = layout.positions.get(edge.targetId);
      const targetCenterX = targetPosition ? getNodeCenterX(targetPosition) : sourceCenterX;
      if (targetCenterX < sourceCenterX) {
        leftEdges.push(edge);
      } else {
        rightEdges.push(edge);
      }
    });
    leftEdges.sort((a, b) => getPositionSortValue(b.targetId) - getPositionSortValue(a.targetId));
    rightEdges.sort((a, b) => getPositionSortValue(a.targetId) - getPositionSortValue(b.targetId));
    leftEdges.forEach((edge, index) => {
      edgeRouting.set(edge, { sourceX: getSidePortX(sourcePosition, -1, index) });
    });
    rightEdges.forEach((edge, index) => {
      edgeRouting.set(edge, { sourceX: getSidePortX(sourcePosition, 1, index) });
    });
  });

  edges.forEach(edge => {
    const sourcePosition = layout.positions.get(edge.sourceId);
    const targetPosition = layout.positions.get(edge.targetId);
    if (!sourcePosition || !targetPosition) return;
    const targetList = incomingEdges.get(edge.targetId) ?? [edge];
    const route = edgeRouting.get(edge);
    const sourceList = outgoingEdges.get(edge.sourceId) ?? [edge];
    const sourceX = route?.sourceX ?? getPortX(sourcePosition, sourceList.indexOf(edge), sourceList.length);
    const sourceY = ROW_GAP + sourcePosition.row * (NODE_HEIGHT + ROW_GAP) + NODE_HEIGHT;
    const targetX = getPortX(targetPosition, targetList.indexOf(edge), targetList.length);
    const targetY = ROW_GAP + targetPosition.row * (NODE_HEIGHT + ROW_GAP);
    const laneKey = `${sourcePosition.row}:${targetPosition.row}`;
    const laneY = getLaneY(sourceY, targetY, edge, laneKey);
    const colorIndex = sourceColorIndex.get(edge.sourceId) ?? 0;
    const directPath = route?.direct ? createDirectPathData(sourcePosition, sourceY, targetPosition, targetY) : null;
    createPath(edge, directPath || createOrthogonalPathData(sourceX, sourceY, targetX, targetY, laneY), colorIndex);
  });

  svg.appendChild(connectorsGroup);

  const nodesById = new Map(nodes.map(scene => [scene.id, scene]));
  const nodesGroup = document.createElementNS(SVG_NS, 'g');
  nodesGroup.classList.add('graph-nodes');

  layout.orderedIds.forEach(sceneId => {
    const scene = nodesById.get(sceneId);
    if (!scene) return;
    const position = layout.positions.get(scene.id);
    if (!position) return;
    const x = COLUMN_GAP + position.column * (NODE_WIDTH + COLUMN_GAP);
    const y = ROW_GAP + position.row * (NODE_HEIGHT + ROW_GAP);

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('tabindex', '0');
    group.setAttribute('role', 'listitem');
    group.dataset.sceneId = scene.id;
    group.setAttribute('transform', `translate(${x}, ${y})`);

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('width', String(NODE_WIDTH));
    rect.setAttribute('height', String(NODE_HEIGHT));
    rect.setAttribute('rx', '12');
    rect.setAttribute('ry', '12');
    rect.classList.add('graph-node');
    if (scene.id === selectedId) rect.classList.add('is-selected');

    const title = document.createElementNS(SVG_NS, 'text');
    title.setAttribute('x', '20');
    title.setAttribute('y', '28');
    title.classList.add('graph-node-title');
    title.textContent = scene.id;

    const type = document.createElementNS(SVG_NS, 'text');
    type.setAttribute('x', '20');
    type.setAttribute('y', '54');
    type.classList.add('graph-node-subtitle');
    type.textContent = translate(`inspector.sceneTypes.${scene.type}`, {
      default: scene.type,
    });

    group.appendChild(rect);
    if (scene.image?.objectUrl) {
      const img = document.createElementNS(SVG_NS, 'image');
      img.setAttribute('href', scene.image.objectUrl);
      img.setAttribute('x', String(NODE_WIDTH - 80));
      img.setAttribute('y', '10');
      img.setAttribute('width', '60');
      img.setAttribute('height', '60');
      img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      img.classList.add('graph-node-thumb');
      group.appendChild(img);
    }

    group.appendChild(title);
    group.appendChild(type);

    const activate = () => onSelect?.(scene.id);
    group.addEventListener('click', activate);
    group.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        activate();
      }
    });

    nodesGroup.appendChild(group);
  });

  svg.appendChild(nodesGroup);
  hostEl.appendChild(svg);
}
