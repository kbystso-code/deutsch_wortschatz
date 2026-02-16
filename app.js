// app.js
const TARGET_SETS = 20;

// 偏り制御のパラメータ
const RECENT_PENALTY_HOURS = 24;     // 直近24時間に出た単語は出にくくする
const NEW_ITEM_BONUS = 3.0;          // 未出題ボーナス
const ERROR_WEIGHT = 4.0;            // ミス率の重み
const RECENT_MIN_FACTOR = 0.25;      // 最近出た単語の最小係数（0にしない）
const STORAGE_KEY = "de_vocab_stats_v1";

const $ = (id) => document.getElementById(id);

const state = {
  vocab: [],
  stats: {},          // id -> stats
  target: TARGET_SETS,
  done: 0,
  score: 0,
  streak: 0,
  phase: "meaning",
  queue: [],
  current: null,
  meaningChoices: [],
  lock: false,
  currentClue: ""     // 1問中はclueを固定
};

function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function intersectTags(aTags, bTags){
  const s = new Set(aTags || []);
  for(const t of (bTags || [])) if(s.has(t)) return true;
  return false;
}

// ---------- stats persistence ----------
function defaultStat(){
  return {
    seen: 0,
    correctMeaning: 0,
    wrongMeaning: 0,
    correctArticle: 0,
    wrongArticle: 0,
    lastSeenAt: 0
  };
}

function loadStats(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveStats(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.stats));
  } catch {}
}

function ensureStat(id){
  if(!state.stats[id]) state.stats[id] = defaultStat();
  return state.stats[id];
}

function recordSeen(itemId){
  const st = ensureStat(itemId);
  st.seen += 1;
  st.lastSeenAt = Date.now();
  saveStats();
}

function recordResult(itemId, phase, isCorrect){
  const st = ensureStat(itemId);
  if(phase === "meaning"){
    if(isCorrect) st.correctMeaning += 1;
    else st.wrongMeaning += 1;
  } else {
    if(isCorrect) st.correctArticle += 1;
    else st.wrongArticle += 1;
  }
  saveStats();
}

function errorRate(st){
  const total = st.correctMeaning + st.wrongMeaning + st.correctArticle + st.wrongArticle;
  const wrong = st.wrongMeaning + st.wrongArticle;
  if(total === 0) return 0;
  return wrong / total; // 0..1
}

function recencyFactor(st){
  if(!st.lastSeenAt) return 1.0;
  const hours = (Date.now() - st.lastSeenAt) / (1000*60*60);
  if(hours >= RECENT_PENALTY_HOURS) return 1.0;

  // 直近ほど小さく（ただし0にはしない）
  const x = hours / RECENT_PENALTY_HOURS; // 0..1
  return Math.max(RECENT_MIN_FACTOR, x);
}

// ---------- weighted sampling without replacement ----------
function pickWeightedUnique(items, k, weightFn){
  const pool = items.slice();
  const picked = [];

  for(let i=0; i<k && pool.length>0; i++){
    const weights = pool.map(weightFn);
    let sum = 0;
    for(const w of weights) sum += Math.max(0, w);

    // すべて0ならシャッフルして先頭から
    if(sum <= 0){
      picked.push(pool.shift());
      continue;
    }

    let r = Math.random() * sum;
    let idx = 0;
    for(; idx<pool.length; idx++){
      r -= Math.max(0, weights[idx]);
      if(r <= 0) break;
    }
    const chosen = pool.splice(Math.min(idx, pool.length-1), 1)[0];
    picked.push(chosen);
  }
  return picked;
}

function itemWeight(item){
  const st = ensureStat(item.id);

  // 未出題ボーナス
  const newBonus = (st.seen === 0) ? NEW_ITEM_BONUS : 1.0;

  // ミス率重み（ミスが多いほど上がる）
  const er = errorRate(st); // 0..1
  const errBoost = 1.0 + (er * ERROR_WEIGHT); // 1..(1+ERROR_WEIGHT)

  // 最近出たペナルティ
  const rec = recencyFactor(st); // RECENT_MIN_FACTOR..1

  // タグやdifficultyで追加調整したければここで
  return newBonus * errBoost * rec;
}

// ---------- choices generation ----------
function buildMeaningChoices(item){
  const pool = state.vocab;

  const sameTag = pool.filter(x => x.id !== item.id && intersectTags(x.tags, item.tags));
  let candidates = sameTag.length >= 10 ? sameTag : sameTag.concat(pool.filter(x => x.id !== item.id));

  // 冠詞違いの誤答を優先
  const diffArticle = candidates.filter(x => x.article !== item.article);
  const pref = diffArticle.length >= 2 ? diffArticle : candidates;

  // ミスが多い単語ほど「同カテゴリ」から誤答を作りやすい（ここは現状維持）
  let distractors = shuffle(pref).slice(0, 2);

  // 重複回避・不足補完
  distractors = Array.from(new Map(distractors.map(d => [d.id, d])).values()).slice(0,2);
  if(distractors.length < 2){
    const rest = pool.filter(x => x.id !== item.id && !distractors.some(d => d.id === x.id));
    distractors = distractors.concat(shuffle(rest).slice(0, 2 - distractors.length));
  }

  return shuffle([item, ...distractors]).map(x => ({
    id: x.id,
    display: x.display,
    isCorrect: x.id === item.id
  }));
}

// ---------- UI render ----------
function render(){
  $("target").textContent = String(state.target);
  $("progress").textContent = String(state.done);
  $("score").textContent = String(state.score);
  $("streak").textContent = String(state.streak);

  $("feedback").textContent = "";
  $("btnNext").disabled = true;

  const item = state.current;
  if(!item) return;

  // clueは「1問の間」固定
  if(!state.currentClue){
    state.currentClue = item.clues_de[Math.floor(Math.random() * item.clues_de.length)];
  }
  $("clueText").textContent = state.currentClue;

  $("wordReveal").style.display = (state.phase === "article") ? "block" : "none";
  // 冠詞フェーズでは冠詞を見せない（lemmaのみ）
  $("wordRevealValue").textContent = (state.phase === "article") ? item.lemma : item.display;

  $("phaseLabel").textContent = (state.phase === "meaning")
    ? "Phase 1: Welches Wort passt?"
    : "Phase 2: Welcher Artikel ist richtig?";

  const choicesDiv = $("choices");
  choicesDiv.innerHTML = "";

  if(state.phase === "meaning"){
    state.meaningChoices.forEach(ch => {
      const btn = document.createElement("button");
      btn.className = "choiceBtn";
      btn.textContent = ch.display;
      btn.onclick = () => onMeaningAnswer(ch);
      choicesDiv.appendChild(btn);
    });
  } else {
    ["der","die","das"].forEach(a => {
      const btn = document.createElement("button");
      btn.className = "choiceBtn";
      btn.textContent = a;
      btn.onclick = () => onArticleAnswer(a);
      choicesDiv.appendChild(btn);
    });
  }
}

function disableChoices(){
  [...document.querySelectorAll(".choiceBtn")].forEach(b => b.disabled = true);
}

function markButtonsMeaning(correctId, chosenId){
  const buttons = [...document.querySelectorAll(".choiceBtn")];
  buttons.forEach((btn) => {
    const label = btn.textContent.trim();
    const matched = state.meaningChoices.find(c => c.display === label);
    if(!matched) return;
    if(matched.id === correctId) btn.classList.add("ok");
    if(matched.id === chosenId && matched.id !== correctId) btn.classList.add("ng");
  });
}

function markButtonsArticle(correctArticle, chosenArticle){
  const buttons = [...document.querySelectorAll(".choiceBtn")];
  buttons.forEach(btn => {
    const a = btn.textContent.trim();
    if(a === correctArticle) btn.classList.add("ok");
    if(a === chosenArticle && a !== correctArticle) btn.classList.add("ng");
  });
}

// ミスが多いほど「短い間隔」で再投入
function requeueCurrentAdaptive(){
  const item = state.current;
  if(!item) return;

  const st = ensureStat(item.id);
  const wrong = st.wrongMeaning + st.wrongArticle;

  // wrongが多いほど短い（2〜6の範囲）
  const afterN = Math.max(2, Math.min(6, 6 - Math.floor(wrong / 2)));

  const insertAt = Math.min(state.queue.length, afterN);
  state.queue.splice(insertAt, 0, item);
}

function onMeaningAnswer(choice){
  if(state.lock) return;
  state.lock = true;
  disableChoices();

  const correct = choice.isCorrect;
  recordResult(state.current.id, "meaning", correct);

  if(correct){
    state.score += 2;
    state.streak += 1;
    $("feedback").textContent = `✅ Richtig: ${state.current.display}`;
    $("feedback").style.color = "var(--ok)";
    markButtonsMeaning(state.current.id, choice.id);

    state.phase = "article";
    state.lock = false;
    setTimeout(render, 320);
  } else {
    state.score = Math.max(0, state.score - 1);
    state.streak = 0;
    $("feedback").textContent = `❌ Falsch. Richtig: ${state.current.display}`;
    $("feedback").style.color = "var(--ng)";
    markButtonsMeaning(state.current.id, choice.id);

    requeueCurrentAdaptive();
    $("btnNext").disabled = false;
    state.lock = false;
  }
}

function onArticleAnswer(article){
  if(state.lock) return;
  state.lock = true;
  disableChoices();

  const correct = (article === state.current.article);
  recordResult(state.current.id, "article", correct);

  if(correct){
    state.score += 2;
    state.streak += 1;
    $("feedback").textContent = `✅ Richtig: ${state.current.display}`;
    $("feedback").style.color = "var(--ok)";
    markButtonsArticle(state.current.article, article);

    state.done += 1;
    $("btnNext").disabled = false;
    state.lock = false;
  } else {
    state.score = Math.max(0, state.score - 1);
    state.streak = 0;
    $("feedback").textContent = `❌ Falsch. Richtig: ${state.current.article} (${state.current.lemma})`;
    $("feedback").style.color = "var(--ng)";
    markButtonsArticle(state.current.article, article);

    requeueCurrentAdaptive();
    $("btnNext").disabled = false;
    state.lock = false;
  }
}

function nextItem(){
  if(state.done >= state.target){
    $("phaseLabel").textContent = "Runde beendet";
    $("clueText").textContent = `🎉 Fertig! ${state.target}/${state.target} geschafft. Score=${state.score}`;
    $("wordReveal").style.display = "none";
    $("feedback").textContent = "";
    $("choices").innerHTML = "";
    $("btnNext").disabled = true;
    return;
  }

  state.phase = "meaning";
  state.current = state.queue.shift();
  state.currentClue = "";              // 次の問題でclueを再抽選
  recordSeen(state.current.id);        // 「見た」を記録
  state.meaningChoices = buildMeaningChoices(state.current);
  render();
}

// ここが「偏り制御」の中核：重み付きで20語選ぶ
function buildRoundQueue(){
  // まず履歴初期化
  for(const it of state.vocab) ensureStat(it.id);

  // 重み付き抽出（重複なし）
  const picked = pickWeightedUnique(state.vocab, TARGET_SETS, itemWeight);

  // 念のため：全体数が少ない場合
  return picked.length ? picked : shuffle(state.vocab).slice(0, TARGET_SETS);
}

function startRound(){
  state.done = 0;
  state.score = 0;
  state.streak = 0;
  state.phase = "meaning";
  state.queue = buildRoundQueue();
  nextItem();
}

async function init(){
  state.stats = loadStats();

  const res = await fetch("./vocab.json", { cache: "no-store" });
  const data = await res.json();
  state.vocab = data.items;

  $("btnNext").addEventListener("click", () => {
    $("btnNext").disabled = true;
    nextItem();
  });
  $("btnRestart").addEventListener("click", () => startRound());

  startRound();
}

init();
