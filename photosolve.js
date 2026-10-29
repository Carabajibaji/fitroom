/* Fitroom: recover the phone camera from 4 points on the floor of a room photo.
   Points are image pixels (origin top-left, y down):
     p1 = back-left corner (back wall meets floor and left wall)
     p2 = back-right corner
     p3 = any point further along the floor edge of the right wall
     p4 = any point further along the floor edge of the left wall
   wallWidth = real width of the back wall in inches.
   Assumes the phone was held level (no tilt sideways) and the lens center is the image center.
   Returns the camera (focal length in px, rotation, translation) with the floor as plane
   X = along the back wall (left to right), Y = from the back wall toward the camera, inches. */

const cr = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dt = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const ln = a => Math.hypot(a[0], a[1], a[2]);
const sc = (a, s) => [a[0]*s, a[1]*s, a[2]*s];

function squareToQuad(q) {
  const [[x0,y0],[x1,y1],[x2,y2],[x3,y3]] = q;
  const sx = x0-x1+x2-x3, sy = y0-y1+y2-y3;
  let a,b,c,d,e,f,g,h;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) { a=x1-x0; b=x3-x0; c=x0; d=y1-y0; e=y3-y0; f=y0; g=0; h=0; }
  else {
    const dx1=x1-x2, dx2=x3-x2, dy1=y1-y2, dy2=y3-y2, den=dx1*dy2-dx2*dy1;
    if (Math.abs(den) < 1e-12) return null;
    g=(sx*dy2-dx2*sy)/den; h=(dx1*sy-sx*dy1)/den;
    a=x1-x0+g*x1; b=x3-x0+h*x3; c=x0; d=y1-y0+g*y1; e=y3-y0+h*y3; f=y0;
  }
  return [a,b,c,d,e,f,g,h,1];
}

/* lens: 'auto' estimates focal length from the floor's perspective; 'wide' = phone 1x, 'ultra' = 0.5x */
export function solveFloor(pts, imgW, imgH, wallWidth, lens = 'auto') {
  const cx = imgW/2, cy = imgH/2, M = Math.max(imgW, imgH);
  const P = pts.map(([x, y]) => [x-cx, y-cy, 1]);
  const L12 = cr(P[0], P[1]), Lr = cr(P[1], P[2]), Ll = cr(P[0], P[3]);
  const V2 = cr(Ll, Lr);                       // where the side walls' floor lines meet (depth direction)
  const Hz = [0, V2[2], -V2[1]];               // level camera: horizon is the horizontal line through V2
  const V1 = cr(L12, Hz);                      // vanishing point of the back wall's direction
  const near = cr(P[3], V1), q3 = cr(near, Lr); // complete the rectangle on the right wall's line
  if (Math.abs(q3[2]) < 1e-12) return { ok: false, why: 'The side lines don\'t meet the way a floor does. Move dots 3 and 4.' };
  const Q = [P[0], P[1], [q3[0]/q3[2], q3[1]/q3[2]], P[3]];
  const H = squareToQuad(Q.map(p => [p[0], p[1]]));
  if (!H) return { ok: false, why: 'Those dots don\'t outline a floor. Spread them out.' };
  const [a,b,c,d,e,f0,g,h] = H;

  let foc = 0.75*M, how = 'phone 1x lens';
  if (lens === 'ultra') { foc = 0.375*M; how = 'phone 0.5x lens'; }
  else if (lens === 'auto') {
    const f2 = -(a*b + d*e)/(g*h);
    if (Math.abs(g*h) > 1e-14 && f2 > 0) {
      const ff = Math.sqrt(f2);
      if (ff > 0.33*M && ff < 2.4*M) { foc = ff; how = 'estimated from the floor'; }
    }
  }
  const k1 = [a/foc, d/foc, g], k2 = [b/foc, e/foc, h], k3 = [c/foc, f0/foc, 1];
  const n1 = ln(k1), n2 = ln(k2);
  if (n1 < 1e-12 || n2 < 1e-12) return { ok: false, why: 'Those dots are too close together.' };
  const lam = n1/wallWidth, depth = wallWidth*n2/n1;
  let r1 = sc(k1, 1/n1), r2 = sc(k2, 1/n2);
  r2 = (() => { const p = dt(r1, r2), v = [r2[0]-p*r1[0], r2[1]-p*r1[1], r2[2]-p*r1[2]]; return sc(v, 1/ln(v)); })();
  let t = sc(k3, 1/lam);
  if (t[2] < 0) { r1 = sc(r1, -1); r2 = sc(r2, -1); t = sc(t, -1); }
  const r3 = cr(r1, r2);                       // points down into the floor for a normal photo
  const up = sc(r3, -1);
  const camH = -dt(up, t);                     // camera height above the floor, inches
  // camera position in floor coordinates
  const C = [-(r1[0]*t[0]+r1[1]*t[1]+r1[2]*t[2]), -(r2[0]*t[0]+r2[1]*t[1]+r2[2]*t[2])];
  const ok = camH > 6 && camH < 400 && depth > 6 && depth < 2000;
  return { ok, why: ok ? '' : 'The dots give an impossible camera. Check that 1 and 2 are the back corners.',
    f: foc, how, r1, r2, up, t, depth, camH, camX: C[0], camY: C[1], H, Q, cx, cy };
}

/* floor point (inches) -> image pixel, or null if behind the camera */
export function projectFloor(sol, X, Y, Z = 0) {
  const { r1, r2, up, t, f, cx, cy } = sol;
  const p = [r1[0]*X + r2[0]*Y + up[0]*Z + t[0], r1[1]*X + r2[1]*Y + up[1]*Z + t[1], r1[2]*X + r2[2]*Y + up[2]*Z + t[2]];
  if (p[2] <= 1) return null;
  return [cx + f*p[0]/p[2], cy + f*p[1]/p[2]];
}
