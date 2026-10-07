import{r,j as e}from"./vendor-CKNYhDUM.js";import{B as h}from"./index-DKYR71jZ.js";import{A as d,m as s}from"./vendor-motion-B0r6xiNP.js";import"./vendor-markdown-Bn-alDSy.js";import"./vendor-radix-BdRwt9T0.js";import"./vendor-icons-DZ1aMybJ.js";const z=["the market pays you to be right, not to feel good","discipline equals freedom","risk defines the returns","print or get printed on","the trend is your friend until the bend at the end","cut your losses short, let your winners run","plan the trade, trade the plan","the market can stay irrational longer than you can stay solvent","buy fear, sell greed","price is truth, everything else is narrative","you don't need to predict, you need to react","scared money don't make money","be fearful when others are greedy","the bulls make money, bears make money, pigs get slaughtered","size wins, timing survives"];function E(){const a=Math.random();return a<.7?"💵":a<.9?"💰":"💴"}function L(a){const t=[];for(let i=0;i<a;i++)t.push({id:i,x:Math.random()*100,delay:Math.random()*6,duration:2.5+Math.random()*3,size:22+Math.random()*26,rotation:Math.random()*60-30,rotationSpeed:(Math.random()-.5)*720,emoji:E(),drift:(Math.random()-.5)*120});return t}function X(a,t){const i=[];for(let c=0;c<a;c++)i.push({id:t+c,x:Math.random()*100,delay:Math.random()*.4,duration:1.2+Math.random()*.6,size:24+Math.random()*20,rotation:Math.random()*90-45,rotationSpeed:(Math.random()-.5)*1080,emoji:E(),drift:(Math.random()-.5)*160});return i}function ee({onExit:a}){const[t,i]=r.useState("atmospheric"),[c,x]=r.useState(0),[u,g]=r.useState(!0),[B,f]=r.useState(!1),[$,y]=r.useState(!1),[C,A]=r.useState(!1),[o]=r.useState(()=>window.matchMedia("(prefers-reduced-motion: reduce)").matches),[O]=r.useState(()=>window.innerWidth<640),b=O?60:120,[R]=r.useState(()=>L(b)),[v,w]=r.useState([]),j=r.useRef(b+1e3),k=r.useRef(!1),Y=r.useRef(null);r.useEffect(()=>{if(o){i("ready");return}const n=[];return n.push(setTimeout(()=>i("tumbling"),800)),n.push(setTimeout(()=>i("slamming"),2e3)),n.push(setTimeout(()=>{y(!0),f(!0),setTimeout(()=>f(!1),80),setTimeout(()=>y(!1),800)},2100)),n.push(setTimeout(()=>i("revealing"),2600)),n.push(setTimeout(()=>i("ready"),3200)),()=>n.forEach(clearTimeout)},[o]),r.useEffect(()=>{if(t!=="ready"||o)return;const n=setInterval(()=>{g(!1),setTimeout(()=>{x(l=>(l+1)%z.length),g(!0)},400)},2500);return()=>clearInterval(n)},[t,o]),r.useEffect(()=>{if(t!=="ready"||o)return;const n=()=>{const T=15+Math.floor(Math.random()*6),P=X(T,j.current);j.current+=T+100,w(P),setTimeout(()=>w([]),2200)},l=setTimeout(n,300),_=setInterval(n,2e3);return()=>{clearTimeout(l),clearInterval(_)}},[t,o]);const m=r.useCallback(()=>{if(!k.current){if(k.current=!0,o){setTimeout(a,300);return}i("exiting"),A(!0),setTimeout(()=>f(!0),120),setTimeout(()=>f(!1),420),setTimeout(a,600)}},[o,a]);r.useEffect(()=>{const n=l=>{(l.key==="Escape"||l.key==="Enter"||l.key===" ")&&(t==="ready"||t==="exiting"?(l.key==="Enter"||l.key==="Escape")&&m():i("ready"))};return window.addEventListener("keydown",n),()=>window.removeEventListener("keydown",n)},[t,m]);const Z=r.useCallback(()=>{t==="ready"?m():t!=="exiting"&&i("ready")},[t,m]),p=t==="ready",F=t==="exiting",S=t==="tumbling"||t==="slamming",N=t==="slamming"||t==="revealing"||t==="ready"||t==="exiting",M=t==="revealing"||t==="ready"||t==="exiting",I=t==="ready"||t==="exiting";return e.jsx(d,{children:t!=="exiting"?e.jsxs(s.div,{className:"fixed inset-0 flex flex-col items-center justify-center overflow-hidden",style:{zIndex:9999,background:"#000",cursor:S?"default":"pointer"},initial:{opacity:1},exit:{opacity:0},transition:{duration:.8,ease:"easeInOut"},onClick:Z,children:[e.jsxs("div",{className:"absolute inset-0 pointer-events-none",children:[e.jsx("div",{style:{position:"absolute",inset:0,background:"radial-gradient(ellipse 80% 60% at 50% 50%, rgba(30,50,80,0.18) 0%, rgba(10,20,40,0.08) 40%, transparent 70%)"}}),e.jsx(s.div,{style:{position:"absolute",inset:0,background:"linear-gradient(90deg, rgba(16,185,129,0.03) 0%, rgba(245,158,11,0.04) 50%, rgba(16,185,129,0.03) 100%)",backgroundSize:"200% 100%"},animate:{backgroundPosition:["0% 0%","100% 0%","0% 0%"]},transition:{duration:12,repeat:1/0,ease:"linear"}}),!o&&e.jsx(H,{})]}),e.jsx(d,{children:B&&e.jsx(s.div,{className:"absolute inset-0 pointer-events-none",style:{background:"#fff",zIndex:10001},initial:{opacity:0},animate:{opacity:.15},exit:{opacity:0},transition:{duration:.08}},"flash")}),e.jsx(d,{children:$&&e.jsx(s.div,{className:"absolute rounded-full pointer-events-none",style:{left:"50%",top:"50%",width:4,height:4,marginLeft:-2,marginTop:-2,border:"2px solid rgba(250,204,21,0.6)",zIndex:1e4},initial:{scale:0,opacity:.8},animate:{scale:200,opacity:0},exit:{},transition:{duration:.7,ease:"easeOut"}},"shockwave")}),e.jsx(d,{children:S&&!o&&e.jsx(s.div,{className:"absolute",style:{perspective:"1200px",perspectiveOrigin:"50% 50%",width:280,height:280,left:"50%",top:"50%",marginLeft:-140,marginTop:-140,zIndex:20},initial:{opacity:0},animate:{opacity:t==="slamming"?0:1},exit:{opacity:0},transition:{opacity:t==="slamming"?{duration:.4,delay:.15}:{duration:.1}},children:e.jsx(q,{phase:t})},"cube-scene")}),(N||M||p||I)&&e.jsxs("div",{className:"relative flex h-full w-full flex-col items-center justify-center gap-[clamp(0.75rem,2vh,1.5rem)] px-[5vw] py-[clamp(1rem,4vh,2.5rem)] text-center",style:{zIndex:30},children:[e.jsx(d,{children:N&&e.jsx(s.div,{className:"flex items-center justify-center",style:{width:"clamp(8rem, 22vw, 18rem)"},initial:{opacity:0,scale:.4},animate:{opacity:1,scale:1},exit:{opacity:0,scale:.8},transition:{duration:.5,ease:[.19,1,.22,1]},children:e.jsx(h,{className:"w-full h-auto drop-shadow-[0_0_40px_rgba(250,204,21,0.9)]"})},"batman-logo-full")}),e.jsx(d,{children:M&&e.jsxs(s.div,{className:"flex max-w-full flex-col items-center",initial:{opacity:0,y:20},animate:{opacity:1,y:0},exit:{opacity:0},transition:{duration:.5,ease:"easeOut"},children:[e.jsx(s.h1,{className:"font-black text-amber-400",style:{fontFamily:"'Bebas Neue', 'Impact', sans-serif",fontSize:"clamp(2rem, 8vw, 5rem)",textShadow:"0 0 40px rgba(245,158,11,0.5), 0 0 80px rgba(245,158,11,0.25)",letterSpacing:"0.2em",lineHeight:1,margin:0},initial:{opacity:0,scale:.85},animate:{opacity:1,scale:1},transition:{duration:.5,delay:.1,ease:"backOut"},children:"BATCAVE"}),e.jsx(s.p,{className:"text-amber-400/50 font-mono uppercase",style:{marginTop:"0.5rem",fontSize:"clamp(0.6rem, 1.4vw, 0.875rem)",letterSpacing:"clamp(0.15em, 0.5vw, 0.4em)"},initial:{opacity:0},animate:{opacity:1},transition:{delay:.3,duration:.5},children:"Market Intelligence Terminal"})]},"batcave-title")}),e.jsx(d,{children:p&&e.jsxs(s.div,{className:"flex w-full max-w-2xl flex-col items-center",initial:{opacity:0},animate:{opacity:1},exit:{opacity:0},transition:{duration:.5,delay:.2},children:[e.jsx("div",{className:"mb-3 h-px w-12 bg-amber-500/30 sm:mb-4 sm:w-16"}),e.jsx("div",{className:"flex min-h-[3rem] items-center justify-center text-center sm:min-h-[3.5rem]",children:e.jsx(d,{mode:"wait",children:e.jsxs(s.p,{className:"font-mono italic text-white/70",style:{fontFamily:"'JetBrains Mono', 'Fira Code', monospace",fontSize:"clamp(0.75rem, 1.8vw, 1rem)",lineHeight:1.5,textShadow:"0 0 20px rgba(16,185,129,0.15)"},initial:{opacity:0,y:8},animate:{opacity:u?1:0,y:u?0:-8},exit:{opacity:0,y:-8},transition:{duration:.35,ease:"easeInOut"},children:["“",z[c],"”"]},c)})}),e.jsx("div",{className:"mt-3 h-px w-12 bg-amber-500/30 sm:mt-4 sm:w-16"})]},"quote-area")}),e.jsx(d,{children:I&&e.jsxs(s.div,{className:"flex w-full max-w-md flex-col items-center",initial:{opacity:0,y:20},animate:{opacity:1,y:0},exit:{opacity:0},transition:{duration:.5,delay:.3},children:[e.jsx(s.p,{className:"font-mono uppercase text-white/25",style:{fontSize:"clamp(0.6rem, 1.2vw, 0.75rem)",letterSpacing:"0.2em",marginBottom:"clamp(0.75rem, 1.5vh, 1.25rem)"},initial:{opacity:0},animate:{opacity:1},transition:{delay:.5,duration:.5},children:"Press Enter or click to continue"}),e.jsxs(s.button,{ref:Y,"data-testid":"button-launch-batcave","aria-label":"Launch BATCAVE",onClick:n=>{n.stopPropagation(),m()},className:"relative block w-full overflow-hidden text-center font-black uppercase text-black cursor-pointer select-none sm:w-auto",style:{background:"#10b981",fontSize:"clamp(0.72rem, 2vw, 1.15rem)",padding:"clamp(0.85rem, 2vh, 1.35rem) clamp(1rem, 4vw, 2.5rem)",borderRadius:"0.5rem",border:"none",fontFamily:"'Bebas Neue', 'Impact', sans-serif",letterSpacing:"0.1em",lineHeight:1.2,boxShadow:"0 0 30px rgba(16,185,129,0.4), 0 0 60px rgba(16,185,129,0.15)",whiteSpace:"normal"},whileHover:{scale:1.04,boxShadow:"0 0 50px rgba(16,185,129,0.7), 0 0 100px rgba(16,185,129,0.3)"},whileTap:{scale:1.15},animate:{scale:[1,1.03,1],boxShadow:["0 0 30px rgba(16,185,129,0.4), 0 0 60px rgba(16,185,129,0.15)","0 0 45px rgba(16,185,129,0.6), 0 0 80px rgba(16,185,129,0.25)","0 0 30px rgba(16,185,129,0.4), 0 0 60px rgba(16,185,129,0.15)"]},transition:{scale:{duration:2,repeat:1/0,ease:"easeInOut"},boxShadow:{duration:2,repeat:1/0,ease:"easeInOut"}},children:[e.jsx(s.div,{className:"pointer-events-none absolute inset-0",style:{background:"linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.25) 50%, transparent 60%)",backgroundSize:"200% 100%"},animate:{backgroundPosition:["200% 0","-200% 0"]},transition:{duration:3,repeat:1/0,ease:"linear"}}),"ARE YOU READY TO FUCKING PRINT"]})]},"cta-area")})]}),p&&!o&&e.jsx("div",{className:"absolute inset-0 pointer-events-none overflow-hidden","aria-hidden":"true",children:R.map(n=>e.jsx(V,{bill:n,exploding:C},n.id))}),p&&!o&&v.length>0&&e.jsx("div",{className:"absolute inset-0 pointer-events-none overflow-hidden","aria-hidden":"true",children:v.map(n=>e.jsx(Q,{bill:n},n.id))}),!p&&!F&&e.jsx(s.div,{className:"absolute bottom-6 text-white/20 text-[10px] font-mono tracking-widest uppercase select-none pointer-events-none",initial:{opacity:0},animate:{opacity:1},transition:{delay:1,duration:.5},style:{zIndex:50},children:"Click or press any key to skip"})]},"splash"):e.jsx(s.div,{className:"fixed inset-0 pointer-events-none",style:{zIndex:9999,background:"#000"},initial:{opacity:.9},animate:{opacity:0},transition:{duration:.4,delay:.1}},"splash-exit")})}function H(){const a=Array.from({length:40},(t,i)=>({id:i,left:`${i/40*100+Math.random()*2.5}%`,height:`${40+Math.random()*60}px`,delay:`${Math.random()*3}s`,duration:`${.4+Math.random()*.6}s`,opacity:.04+Math.random()*.08}));return e.jsxs("div",{className:"absolute inset-0 overflow-hidden pointer-events-none",children:[e.jsx("style",{children:`
        @keyframes rain-fall {
          0% { transform: translateY(-100px); opacity: var(--rain-opacity); }
          80% { opacity: var(--rain-opacity); }
          100% { transform: translateY(110vh); opacity: 0; }
        }
      `}),a.map(t=>e.jsx("div",{style:{position:"absolute",left:t.left,top:0,width:"1px",height:t.height,background:"linear-gradient(to bottom, transparent, rgba(150,180,220,0.7), transparent)",animation:`rain-fall ${t.duration} linear ${t.delay} infinite`,"--rain-opacity":t.opacity}},t.id))]})}function q({phase:a}){return e.jsxs(e.Fragment,{children:[e.jsx("style",{children:`
        .batcave-cube-wrapper {
          transform-style: preserve-3d;
          width: 280px;
          height: 280px;
          position: relative;
          transform-origin: center center;
        }

        .batcave-cube-wrapper.phase-tumbling {
          animation: cubeTumble 1.2s cubic-bezier(0.19, 1, 0.22, 1) forwards;
        }

        .batcave-cube-wrapper.phase-slamming {
          animation: cubeSlam 0.5s cubic-bezier(0.19, 1, 0.22, 1) forwards;
        }

        @keyframes cubeTumble {
          0% {
            transform: scale(0.6) rotateX(0deg) rotateY(0deg) rotateZ(0deg);
            opacity: 0;
          }
          15% { opacity: 1; }
          100% {
            transform: scale(1.0) rotateX(360deg) rotateY(720deg) rotateZ(0deg);
            opacity: 1;
          }
        }

        @keyframes cubeSlam {
          0% {
            transform: scale(1.0) rotateX(360deg) rotateY(720deg) rotateZ(0deg);
            opacity: 1;
          }
          60% {
            transform: scale(1.8) rotateX(360deg) rotateY(720deg) rotateZ(0deg);
            opacity: 0.9;
          }
          100% {
            transform: scale(2.5) rotateX(360deg) rotateY(720deg) rotateZ(0deg);
            opacity: 0;
          }
        }

        .cube-face {
          position: absolute;
          width: 280px;
          height: 280px;
          backface-visibility: hidden;
          border: 1px solid rgba(250, 204, 21, 0.15);
          background: #050505;
          overflow: hidden;
        }

        .cube-face::before {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(135deg, rgba(250,204,21,0.06) 0%, transparent 50%, rgba(250,204,21,0.03) 100%);
          pointer-events: none;
        }

        /* Chrome rim on edges */
        .cube-face::after {
          content: '';
          position: absolute;
          inset: 0;
          box-shadow: inset 0 0 20px rgba(255,255,255,0.04), inset 1px 1px 0 rgba(255,255,255,0.08), inset -1px -1px 0 rgba(0,0,0,0.5);
          pointer-events: none;
        }

        .cube-face.front  { transform: translateZ(140px); background: #060606; }
        .cube-face.back   { transform: rotateY(180deg) translateZ(140px); }
        .cube-face.right  { transform: rotateY(90deg) translateZ(140px); }
        .cube-face.left   { transform: rotateY(-90deg) translateZ(140px); }
        .cube-face.top    { transform: rotateX(90deg) translateZ(140px); }
        .cube-face.bottom { transform: rotateX(-90deg) translateZ(140px); }

        /* Tech-line texture on side faces */
        .cube-face.right::before,
        .cube-face.left::before,
        .cube-face.top::before,
        .cube-face.bottom::before {
          background:
            repeating-linear-gradient(
              0deg,
              transparent,
              transparent 18px,
              rgba(250,204,21,0.04) 18px,
              rgba(250,204,21,0.04) 19px
            ),
            repeating-linear-gradient(
              90deg,
              transparent,
              transparent 18px,
              rgba(250,204,21,0.03) 18px,
              rgba(250,204,21,0.03) 19px
            );
        }
      `}),e.jsxs("div",{className:`batcave-cube-wrapper phase-${a}`,children:[e.jsx("div",{className:"cube-face front flex items-center justify-center",children:e.jsx(h,{className:"w-48 drop-shadow-[0_0_24px_rgba(250,204,21,0.7)]"})}),e.jsx("div",{className:"cube-face back flex items-center justify-center",children:e.jsx(h,{className:"w-48 drop-shadow-[0_0_16px_rgba(250,204,21,0.4)]"})}),e.jsx("div",{className:"cube-face right"}),e.jsx("div",{className:"cube-face left"}),e.jsx("div",{className:"cube-face top"}),e.jsx("div",{className:"cube-face bottom"})]})]})}function V({bill:a,exploding:t}){const i=Math.random()*360,c=150+Math.random()*300,x=Math.cos(i*Math.PI/180)*c,u=Math.sin(i*Math.PI/180)*c;return t?e.jsx(s.div,{className:"absolute select-none pointer-events-none",style:{left:`${a.x}%`,top:"50%",fontSize:`${a.size}px`,lineHeight:1},animate:{x,y:u,opacity:0,scale:0,rotate:a.rotation+720},transition:{duration:.8,ease:"easeOut"},children:a.emoji}):e.jsx("div",{className:"absolute select-none pointer-events-none",style:{left:`${a.x}%`,top:"-80px",fontSize:`${a.size}px`,lineHeight:1,animation:`bill-fall-${a.id%5} ${a.duration}s linear ${a.delay}s infinite`,"--bill-drift":`${a.drift}px`},children:e.jsx("div",{style:{animation:`bill-spin ${Math.abs(a.rotationSpeed)/180+1.5}s linear infinite ${a.rotationSpeed<0?"reverse":""}`,transform:`rotate(${a.rotation}deg)`},children:a.emoji})})}function Q({bill:a}){return e.jsx(s.div,{className:"absolute select-none pointer-events-none",style:{left:`${a.x}%`,top:"-60px",fontSize:`${a.size}px`,lineHeight:1},initial:{y:0,x:0,opacity:1,rotate:a.rotation},animate:{y:"120vh",x:a.drift,opacity:[1,1,.7,0],rotate:a.rotation+a.rotationSpeed/2},transition:{duration:a.duration,delay:a.delay,ease:"easeIn"},children:a.emoji})}export{ee as default};
