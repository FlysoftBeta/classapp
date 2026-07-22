import React, {
  CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const SPRING_K = 0.008;
const DAMPING = 0.82;
const WAVE_AMP = 35; // 稍微调大波浪幅度，让起伏更明显
const Z_STEP = 5;

const lerp = (val: number, min: number, max: number) =>
  (val - min) / (max - min);
const getEdgeId = (type: number, i: number, j: number, cols: number) =>
  (j * cols + i) * 2 + type;

interface TerrainNode {
  baseZ: number;
  currentZ: number;
  v: number;
  a: number;
}

interface ContourPoint {
  x: number;
  y: number;
  id: number;
}

interface ContourSegment {
  p1: ContourPoint;
  p2: ContourPoint;
}

export default function EndfieldLogo({
  color,
  styles: wrapperStyles,
}: {
  color: string;
  styles?: CSSProperties;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerSize, setContainerSize] = useState(0);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const observer = new ResizeObserver(() => {
      setContainerSize(
        Math.min(wrapper.clientWidth, wrapper.clientHeight) * 0.95,
      );
    });

    observer.observe(wrapper);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Contour masks
    const maskPath1 = new Path2D(
      "m 68.16137,60.154891 c 0,0 0.177136,-0.708539 0.637686,-0.779394 0.460549,-0.07085 14.347899,0.03543 14.347899,0.03543 0,0 0.602255,0.03543 0.779391,0.67311 0.177133,0.637686 0.354269,2.338176 0.354269,2.338176 0,0 0.03543,0.425125 0.460549,0.425125 0.425122,0 2.409029,-0.03543 2.409029,-0.03543 0,0 0.283416,0.07085 0.283416,-0.425122 0,-0.495977 0.247989,-2.869581 0.247989,-2.869581 0,0 -0.03543,-0.212561 0.389697,-0.212561 0.425122,0 12.080575,0.08857 12.080575,0.08857 0,0 1.9131,0.01771 2.47988,0.371982 0.3897,0.743966 1.34623,2.090187 -0.74396,3.400983 -2.090188,1.310796 -4.570072,1.558785 -6.128857,2.727873 -1.558785,1.169088 -2.531,2.914533 -3.241562,4.118376 -0.836234,1.416759 -1.963794,3.269675 -1.67982,4.120875 0.136752,0.409907 -7.239967,-1.9825 -9.912858,-2.850892 -0.603108,-0.195943 -5.542727,-6.43131 -12.702475,-8.836294 z",
    );
    const maskPath2 = new Path2D(
      "m 80.348229,73.422268 11.070907,3.117567 c 0,0 1.913054,0.814819 0.903386,1.930768 -1.009666,1.115946 -1.399363,1.204513 -1.824485,1.665062 -0.425122,0.46055 -0.318841,3.808394 -0.318841,3.808394 0,0 0.761677,4.871199 1.275368,5.190043 0.513689,0.318842 -10.486366,0.513689 -10.486366,0.513689 0,0 -0.495977,-2.533023 -0.726252,-2.781012 -0.230275,-0.247988 -1.328507,-1.02738 -1.204513,-1.647351 0.123994,-0.619972 1.204513,-1.363935 1.275368,-1.523357 0.07085,-0.159422 0.407408,-2.320462 -0.05314,-3.347842 -0.46055,-1.027382 -0.230275,-3.046714 -0.761677,-3.6844 -0.531405,-0.637685 -1.434791,-1.930767 -1.434791,-1.930767 0,0 -0.01773,-0.531403 0.602258,-0.72625 0.619972,-0.194849 1.115946,-0.673113 1.682778,-0.584544 z",
    );
    const maskPath3 = new Path2D(
      "m 81.853872,120.8589 c 0.850244,0.23027 7.297941,1.66506 7.634499,2.14333 0.336556,0.47826 1.328508,0.72625 0.212561,1.62963 -1.115949,0.90339 -1.009668,3.70211 -1.009668,3.70211 0,0 -0.106281,1.66507 -0.03543,2.60388 0.07085,0.93882 -2.338176,8.85673 -2.781014,10.41551 -0.442836,1.55879 -1.859913,-4.18037 -1.859913,-4.18037 0,0 -0.779385,-2.60388 -1.328502,-4.19809 -0.549117,-1.59421 -1.204515,-3.40098 -1.222229,-3.80839 -0.01771,-0.40741 0.613012,-0.62339 0.655398,-1.02738 0.06843,-0.65224 -0.442836,-1.16909 -0.690824,-1.8422 0,0 -0.03543,-3.2947 -0.35427,-3.70211 -0.318842,-0.40741 -1.169088,-1.75363 0.779392,-1.73592 z",
    );
    const maskPath4 = new Path2D("m 0,89 h 200 v 30 h -200 z");

    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const ctx = canvas.getContext("2d")!;

    let animationFrameId: number;
    let resizeTimeout: string | number | NodeJS.Timeout | undefined;

    let gridSize: number, cols: number, rows: number;
    let grid: (TerrainNode | undefined)[][] = [];
    let time = 0;
    let activeRows: ({ start: number; end: number } | null)[] = [];
    let triTopY: number, triBotY: number, triHalfW: number, triCx: number, triH;
    let globalMinZ = 0,
      globalMaxZ = 1;

    const init = () => {
      container.style.width = `${containerSize}px`;
      container.style.height = `${containerSize}px`;

      canvas.width = containerSize;
      canvas.height = containerSize;
      canvas.style.transform = `translateY(-${containerSize * 0.03}px)`;

      cols = 20;
      gridSize = containerSize / cols;
      rows = 20;

      triH = containerSize * 0.7;
      const triW = triH * (2 / Math.sqrt(3));

      triTopY = (containerSize - triH) / 2;
      triBotY = triTopY + triH;
      triCx = containerSize / 2;
      triHalfW = triW / 2;

      grid = [];
      activeRows = [];

      // Culling
      for (let j = 0; j < rows; j++) {
        const y = j * gridSize;
        if (y < triTopY - gridSize * 2 || y > triBotY + gridSize * 2) {
          activeRows[j] = null;
          continue;
        }
        const ratio = Math.max(0, Math.min(1, (triBotY - y) / triH));
        const currHalfW = triHalfW * ratio;
        const startI = Math.max(
          0,
          Math.floor((triCx - currHalfW) / gridSize) - 2,
        );
        const endI = Math.min(
          cols - 1,
          Math.ceil((triCx + currHalfW) / gridSize) + 2,
        );
        activeRows[j] = { start: startI, end: endI };
      }

      for (let i = 0; i < cols; i++) grid[i] = [];

      // Terrain
      for (let j = 0; j < rows; j++) {
        if (!activeRows[j]) continue;
        for (let i = activeRows[j]!.start; i <= activeRows[j]!.end; i++) {
          const nx = i * 0.07;
          const ny = j * 0.07;

          const gradient = (nx + ny) * 60;

          const largeFeatures = Math.sin(nx * 2.1 + ny * 1.7) * 40;
          const mediumHills = Math.cos(nx * 5.3 - ny * 4.1) * 20;
          const smallDetails = Math.sin(nx * 11.3 + ny * 9.7) * 8;

          const baseZ = gradient + largeFeatures + mediumHills + smallDetails;

          grid[i][j] = { baseZ: baseZ, currentZ: baseZ, v: 0, a: 0 };
        }
      }
    };

    const updatePhysics = () => {
      time += 0.003;
      for (let j = 0; j < rows; j++) {
        if (!activeRows[j]) continue;
        for (let i = activeRows[j]!.start; i <= activeRows[j]!.end; i++) {
          const node = grid[i][j];
          if (!node) continue;

          const nx = i / (cols - 1);
          const ny = j / (rows - 1);

          const wave1 =
            Math.sin(nx * 4 + time) * Math.cos(ny * 4 - time * 0.8) * 1.0;
          const wave2 =
            Math.sin(nx * 12 - time * 1.2) *
            Math.cos(ny * 10 + time * 1.1) *
            0.4;
          const wave3 =
            Math.sin(nx * 30 + time * 1.5) *
            Math.cos(ny * 35 - time * 0.9) *
            0.15;

          const targetZ =
            node.baseZ + ((wave1 + wave2 + wave3) / 1.55) * WAVE_AMP;
          node.a = (targetZ - node.currentZ) * SPRING_K;
          node.v = (node.v + node.a) * DAMPING;
          node.currentZ += node.v;
        }
      }
    };

    const stitchSegments = (segments: ContourSegment[]) => {
      const adjMap = new Map<
        number,
        { point: ContourPoint; seg: ContourSegment }[]
      >();
      for (const seg of segments) {
        if (!adjMap.has(seg.p1.id)) adjMap.set(seg.p1.id, []);
        if (!adjMap.has(seg.p2.id)) adjMap.set(seg.p2.id, []);
        adjMap.get(seg.p1.id)!.push({ point: seg.p2, seg });
        adjMap.get(seg.p2.id)!.push({ point: seg.p1, seg });
      }
      const paths: ContourPoint[][] = [],
        visitedSegs = new Set<ContourSegment>();
      for (const seg of segments) {
        if (visitedSegs.has(seg)) continue;
        const path = [seg.p1, seg.p2];
        visitedSegs.add(seg);

        let currId = seg.p2.id;
        while (true) {
          const edges = adjMap.get(currId);
          const nextEdge = edges
            ? edges.find((e) => !visitedSegs.has(e.seg))
            : null;
          if (!nextEdge) break;
          path.push(nextEdge.point);
          visitedSegs.add(nextEdge.seg);
          currId = nextEdge.point.id;
        }

        currId = seg.p1.id;
        while (true) {
          const edges = adjMap.get(currId);
          const nextEdge = edges
            ? edges.find((e) => !visitedSegs.has(e.seg))
            : null;
          if (!nextEdge) break;
          path.unshift(nextEdge.point);
          visitedSegs.add(nextEdge.seg);
          currId = nextEdge.point.id;
        }
        paths.push(path);
      }
      return paths;
    };

    const drawContours = () => {
      ctx.clearRect(0, 0, containerSize, containerSize);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(triCx - triHalfW, triTopY);
      ctx.lineTo(triCx + triHalfW, triTopY);
      ctx.lineTo(triCx, triBotY);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.clip();

      // Transparant Contours
      ctx.globalCompositeOperation = "destination-out";

      // 计算当前全图极值
      globalMinZ = Infinity;
      globalMaxZ = -Infinity;
      for (let j = 0; j < rows; j++) {
        if (!activeRows[j]) continue;
        for (let i = activeRows[j]!.start; i <= activeRows[j]!.end; i++) {
          const node = grid[i]?.[j];
          if (node) {
            const z = node.currentZ;
            if (z < globalMinZ) globalMinZ = z;
            if (z > globalMaxZ) globalMaxZ = z;
          }
        }
      }

      const startZ = Math.floor(globalMinZ / Z_STEP) * Z_STEP;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      // Draw contours
      for (let z = startZ; z <= globalMaxZ; z += Z_STEP) {
        ctx.lineWidth = 0.7 * containerSize * 0.01;
        ctx.strokeStyle = "rgba(255, 255, 255, 1)";

        const segments: ContourSegment[] = [];
        for (let j = 0; j < rows - 1; j++) {
          if (!activeRows[j] || !activeRows[j + 1]) continue;
          const startI = Math.min(
            activeRows[j]!.start,
            activeRows[j + 1]!.start,
          );
          const endI = Math.max(activeRows[j]!.end, activeRows[j + 1]!.end);

          for (let i = startI; i < endI; i++) {
            const n0 = grid[i][j],
              n1 = grid[i + 1][j],
              n2 = grid[i + 1][j + 1],
              n3 = grid[i][j + 1];
            if (!n0 || !n1 || !n2 || !n3) continue;

            const x = i * gridSize,
              y = j * gridSize;
            const v0 = n0.currentZ,
              v1 = n1.currentZ,
              v2 = n2.currentZ,
              v3 = n3.currentZ;
            let state = 0;

            if (v0 >= z) state |= 8;
            if (v1 >= z) state |= 4;
            if (v2 >= z) state |= 2;
            if (v3 >= z) state |= 1;

            if (state === 0 || state === 15) continue;

            const a = {
              x: x + gridSize * lerp(z, v0, v1),
              y: y,
              id: getEdgeId(0, i, j, cols),
            };
            const b = {
              x: x + gridSize,
              y: y + gridSize * lerp(z, v1, v2),
              id: getEdgeId(1, i + 1, j, cols),
            };
            const c = {
              x: x + gridSize * lerp(z, v3, v2),
              y: y + gridSize,
              id: getEdgeId(0, i, j + 1, cols),
            };
            const d = {
              x: x,
              y: y + gridSize * lerp(z, v0, v3),
              id: getEdgeId(1, i, j, cols),
            };

            switch (state) {
              case 1:
                segments.push({ p1: c, p2: d });
                break;
              case 2:
                segments.push({ p1: b, p2: c });
                break;
              case 3:
                segments.push({ p1: b, p2: d });
                break;
              case 4:
                segments.push({ p1: a, p2: b });
                break;
              case 5:
                segments.push({ p1: a, p2: d }, { p1: b, p2: c });
                break;
              case 6:
                segments.push({ p1: a, p2: c });
                break;
              case 7:
                segments.push({ p1: a, p2: d });
                break;
              case 8:
                segments.push({ p1: a, p2: d });
                break;
              case 9:
                segments.push({ p1: a, p2: c });
                break;
              case 10:
                segments.push({ p1: a, p2: b }, { p1: c, p2: d });
                break;
              case 11:
                segments.push({ p1: a, p2: b });
                break;
              case 12:
                segments.push({ p1: b, p2: d });
                break;
              case 13:
                segments.push({ p1: b, p2: c });
                break;
              case 14:
                segments.push({ p1: c, p2: d });
                break;
            }
          }
        }

        const paths = stitchSegments(segments);
        ctx.beginPath();
        paths.forEach((path) => {
          if (path.length < 2) return;
          ctx.moveTo(path[0].x, path[0].y);
          for (let i = 1; i < path.length - 1; i++) {
            const xc = (path[i].x + path[i + 1].x) / 2;
            const yc = (path[i].y + path[i + 1].y) / 2;
            ctx.quadraticCurveTo(path[i].x, path[i].y, xc, yc);
          }
          ctx.lineTo(path[path.length - 1].x, path[path.length - 1].y);
        });
        ctx.stroke();
      }

      // Draw masks
      ctx.save();
      const scaleRatio = containerSize / 512;
      ctx.scale(scaleRatio, scaleRatio);
      ctx.translate(-67, -130);
      ctx.scale(3.8, 3.8);
      ctx.fillStyle = "rgba(0,0,0,1)";

      ctx.fill(maskPath1);
      ctx.fill(maskPath2);
      ctx.fill(maskPath3);
      ctx.fill(maskPath4);

      ctx.restore();
      ctx.restore();
    };

    const animate = () => {
      updatePhysics();
      drawContours();
      animationFrameId = requestAnimationFrame(animate);
    };

    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(init, 100);
    };

    window.addEventListener("resize", handleResize);
    init();
    animate();

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationFrameId);
      clearTimeout(resizeTimeout);
    };
  }, [containerSize, color]);

  return (
    <div style={{ ...wrapperStyles, position: "relative" }} ref={wrapperRef}>
      <div ref={containerRef} style={styles.syncContainer}>
        <canvas ref={canvasRef} style={styles.canvas} />
        <svg
          style={styles.logoOverlay}
          viewBox="0 0 512 512"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g fill={color}>
            <path d="M104.5,239.2v40.7H83.2V203h21.7l29.2,40.1l0.4-0.1V203h1.6c11.6,0,23.2-0.1,34.8,0c11.6,0.1,21.5,4.1,29.5,12.5 c6,6.2,9.1,13.8,9.9,22.4s-0.4,15.1-4.2,22c-5.3,10.1-13.9,16-24.9,18.7c-3.5,0.8-7,1.3-10.6,1.3c-11.7,0.1-23.5,0.1-35.2,0.1H134 l-29.2-41L104.5,239.2 M156.5,260.3c5.9-0.2,11.6,0.4,17.4-0.6c9.1-1.6,14.2-7,15-16.2c0.6-6.7-1.3-12.5-6.9-16.7 c-3-2.3-6.7-3.7-10.5-3.9c-4.7-0.3-9.3-0.1-13.9-0.2l-1,0.2L156.5,260.3z" />
            <path d="M364.4,280v-76.9h21.2v57.1h30.6V203h1.8c11.4,0,22.8-0.1,34.1,0c11.4,0.1,22.2,4.3,30.2,13.2c6,6.7,9,14.6,9.4,23.5 c0.4,6.6-0.9,13.3-3.7,19.3c-5.3,10.5-14.1,16.8-25.4,19.7c-3.5,0.9-7,1.3-10.6,1.3c-28.7,0.1-57.5,0.1-86.2,0.1h-1.5 M437.9,260.5 h8.7c3,0,6-0.3,8.9-0.7c7.1-1.4,12.4-5.2,14.2-12.6c0.5-2.2,0.7-4.4,0.5-6.7c-0.3-7.2-3.8-12.4-10.3-15.5c-2.4-1.2-5.1-1.9-7.9-1.9 c-4.3-0.1-8.5-0.1-12.8-0.1l-1.3,0.2V260.5z" />
            <path d="M42,222.8c0,0.7-0.1,1.3-0.1,1.9v7.8h26.2v17.9h-26v9.9h36.7V280H20.6v-76.9h57.5v19.7H42z" />
            <polygon points="301.7,279.9 301.7,203 359.3,203 359.3,222.7 323.3,222.7 323.3,232.4 349.2,232.4 349.2,250.3 323.3,250.3 323.3,260.3 360,260.3 360,279.9 	" />
            <polygon points="271.2,222.8 236.2,222.8 236.2,234 263.1,234 263.1,253.9 236.1,253.9 236.1,280 214.8,280 214.8,203.1 271.2,203.1 	" />
            <rect x="275" y="203.1" width="21.2" height="76.9" />
            <path d="M443.3,157h-3l16.8-29.2c5.6-9.6,11.2-19.3,16.8-29l16.7-28.9l17-29.4h-9.8l4.4-7.9h-310c-0.1-0.9-0.1-1.6-0.1-2.2 c1.3-0.6,312.4-0.7,314.5-0.1c-1.4,2.4-2.7,4.8-4.2,7.5L512,38C488.9,77.9,466.1,117.4,443.3,157" />
            <path d="M256.3,462.6l-5.7,9.4c-32.1-55.6-64-110.9-96.1-166.5l2.4-0.8c7.9,13.5,15.7,27,23.4,40.4l23.4,40.5l23.3,40.4l23.6,40.8 l5.6-9.3c1.8,3,3.5,5.7,5.3,8.8l31.8-54.9l2.1,1.7l-33.8,58.4L256.3,462.6" />
            <path d="M0,37.9h9.7l-4.2-7.6c1.2-0.5,23.6-0.6,25.6-0.1c0.1,0.6,0.2,1.3,0.4,2.2H9.7c1.6,2.7,2.8,5.1,4.4,7.8 c-3.3,0.2-6.3,0.1-9.6,0.3c27.8,48.2,55.6,96.4,83.4,144.4c-2.2,0.6-2.9,0.3-3.9-1.4c-3.1-5.3-6.2-10.6-9.2-16L1,39.8 C0.7,39.4,0.5,38.8,0,37.9" />
            <path d="M351.5,311.3l2.2,0.8c-9.7,17-19.4,33.7-29.2,50.7l-1.5-1.9C323.2,359.4,350.3,312.5,351.5,311.3" />
            <path d="M102.9,286.1h3.6l5.8,7.3h0.2v-7.1h3.6v13.1h-3.6l-5.6-7.1l-0.4,0.1v7h-3.6V286.1z" />
            <path d="M148.6,299.3V286c2.4,0.1,4.9-0.4,7.3,0.4c2.9,1.1,4.7,4,4.4,7.1c-0.3,3-2.6,5.4-5.6,5.8 C152.7,299.4,150.6,299.4,148.6,299.3 M152.3,296.1c1.6,0.3,2.9-0.1,3.6-1.6c0.7-1.2,0.7-2.7-0.1-3.9c-0.7-1.2-2.2-1.8-3.6-1.3 L152.3,296.1z" />
            <path d="M323.4,294.1c1.3,1.7,2.5,3.3,3.9,5.3h-4.5l-2.7-4h-0.3v3.9h-3.7v-13.1c2.4,0,4.7-0.1,7,0.1c2.3,0.2,2.5,1.6,2.7,3.2 c0.2,1.6-0.1,3.2-1.7,4.2L323.4,294.1 M320,289v2.7c1.3,0.3,2.1-0.1,2.3-1.3C322.5,289.1,321.3,288.7,320,289" />
            <path d="M191.9,286.1h3.6c0.1,0.6,0.1,1.1,0.1,1.7v6.2c0.1,1.6,0.8,2.5,2.2,2.5s2.1-0.9,2.2-2.4c0.1-1.6,0-4,0.1-5.9 c0-0.7,0-1.3,0.1-2h3.5c0.1,0.6,0.1,1.1,0.1,1.7v6.1c0,2.3-0.9,4.2-3,5.2c-2.2,1.2-5,0.9-7-0.6c-0.6-0.5-1.1-1.2-1.3-1.9 C191.6,293.1,192.1,289.6,191.9,286.1" />
            <path d="M95.4,32.4c0.2-0.9,0.3-1.5,0.4-2c1.6-0.7,33.7-0.7,35.3,0c-0.2,0.7-0.3,1.3-0.4,2H95.4z" />
            <path d="M244.8,286.9c-0.4,0.9-0.9,1.7-1.3,2.6c-1.3-0.3-2.7-1.6-3.9,0.4l1.4,1l1.5,0.5c2,0.7,2.8,1.8,2.9,3.6 c0.1,1.9-1,3.7-2.8,4.5c-2.4,0.9-5.2,0.4-7.1-1.3l1.3-2.5c3.8,1.5,3.9,1.5,4.8-0.3c-0.4-0.3-0.9-0.6-1.3-0.9l-1.3-0.4 c-2.3-0.8-3.1-1.9-3-3.8c0-2.1,1.4-3.8,3.4-4.3C241.2,285.4,243.2,285.8,244.8,286.9" />
            <path d="M441.1,289.5c-2.8-1-3.1-1-3.6,0.7c0.7,0.3,1.4,0.6,2.1,0.9c2.7,0.9,3.6,2.1,3.4,4.3c-0.2,2.2-1.6,3.8-4,4.2 c-2.1,0.4-4.2-0.2-5.9-1.5l1.4-2.7c3.6,1.6,4.5,1.6,4.6-0.6l-2.6-1c-2.3-0.8-3-1.8-2.8-4.2c0.1-2,1.7-3.6,3.6-3.9 c1.8-0.3,3.7,0.2,5.2,1.2L441.1,289.5" />
            <path d="M394.3,299.3v-13.2h7.6v2.8l-3.9,0.3v1.8l3.6,0.1v2.9l-3.6,0.2v1.9h3.9v3.1H394.3z" />
            <path d="M49.7,291.2v2.4H20.4c0-0.3-0.1-0.7-0.1-1v-1.4H49.7z" />
            <path d="M458.7,293.4v-2.2h29.4c0,0.7,0.1,1.4,0.1,2.1C486.9,293.8,460.5,293.8,458.7,293.4" />
            <path d="M251.4,474.4c1.6-2.6,3-5,4.7-7.8l4.6,7.7l-4.6,7.8L251.4,474.4" />
            <path d="M278.6,289.3l-2.6-0.4v-2.9h9.1v2.9l-2.7,0.4v10h-3.8V289.3z" />
            <path d="M153.9,32.4l-0.4-2.2c0.6-0.2,1.3-0.3,1.9-0.3H176l1.7,0.2v2.2H153.9z" />
            <rect x="358.4" y="286.1" width="3.4" height="13.3" />
            <rect x="66.9" y="286.1" width="3.5" height="13.2" />
          </g>
        </svg>
      </div>
    </div>
  );
}

const styles = {
  syncContainer: {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: "100%",
    height: "100%",
    transform: "translate(-50%, -50%)",
  },
  canvas: {
    position: "absolute",
    top: 0,
    left: 0,
    zIndex: 1,
    display: "block",
  },
  logoOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    zIndex: 10,
    pointerEvents: "none",
    display: "block",
  },
} as const;
