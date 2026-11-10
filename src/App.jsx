import React, { useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, AudioLines, BadgeCheck, BarChart3, Bell, BookOpen, Boxes, Braces, Check, CheckCheck, ChevronDown, ChevronRight, CircleDollarSign, CircleHelp, Coins, Copy, CreditCard, Download, FileCheck2, FileCode2, FileText, Fingerprint, FlaskConical, FolderOpen, Gauge, Layers3, Loader2, LockKeyhole, Maximize2, PanelRightClose, Play, Plus, RefreshCw, ScanLine, Settings2, ShieldCheck, ShieldX, Sparkles, Terminal, Workflow, X, Zap } from 'lucide-react';
import QRCode from 'qrcode';
import { toPng } from 'html-to-image';

const money = value => Number(value || 0).toFixed(2);
const unique = () => crypto.randomUUID();
const modeNames = { oneoff: '单次买断', credits: '科研积分', subscription: 'Pro 订阅' };
const granted = o => o?.entitlementStatus ? o.entitlementStatus === 'ENTITLEMENT_GRANTED' : o?.status === 'ENTITLEMENT_GRANTED';
const refunded = o => o?.status === 'REFUND_SUCCESS' || o?.entitlementStatus === 'REVOKED';
const received = o => o?.receivedAmount ?? (o?.paidAt && !refunded(o) ? o.amount : 0);
const icons = [FileCheck2, FlaskConical, BookOpen, ShieldX];

async function api(path, body) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求未完成，请重试');
  return data;
}

function Sparkline({ color = '#1677ff', variant = 0 }) {
  const paths = ['M1 35L14 34L24 25L37 29L46 17L59 20L71 8L82 12L95 3', 'M1 33L15 24L27 29L38 18L49 21L61 11L72 15L85 7L95 10', 'M1 33L14 27L26 29L39 17L49 20L63 9L76 13L85 5L95 5', 'M1 32L20 32L30 32L40 21L54 21L64 21L74 10L95 10'];
  return <svg className="sparkline" viewBox="0 0 100 42"><path d={`${paths[variant]}L95 42H1Z`} fill={color} opacity=".07"/><path d={paths[variant]} stroke={color} strokeWidth="1.8" fill="none"/></svg>;
}

function App() {
  const [data, setData] = useState(null);
  const [caseId, setCaseId] = useState('patent');
  const [draft, setDraft] = useState('');
  const [estimate, setEstimate] = useState(null);
  const [mode, setMode] = useState('oneoff');
  const [orderId, setOrderId] = useState(null);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState(null);
  const [drawer, setDrawer] = useState(false);
  const [logId, setLogId] = useState(null);
  const [logTab, setLogTab] = useState('request');
  const [previewTab, setPreviewTab] = useState('diagnosis');
  const [modal, setModal] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [autopilot, setAutopilot] = useState(null);
  const [ledgerFilter, setLedgerFilter] = useState('all');
  const [qr, setQr] = useState('');
  const [paymentUrl, setPaymentUrl] = useState('');
  const [activeNav, setActiveNav] = useState('workspace');
  const fileRef = useRef(null);
  const ledgerRef = useRef(null);
  const receiptRef = useRef(null);
  const checkoutRef = useRef(null);
  const toastTimer = useRef(null);
  const cases = data?.cases || [];
  const selected = cases.find(c => c.id === caseId);
  const orders = data?.orders || [];
  const order = orders.find(o => o.id === orderId);
  const env = data?.environment;
  const simulation = env?.mode !== 'sandbox';
  const kpis = data?.kpis || {};
  const logs = data?.logs || [];
  const currentLog = logs.find(l => l.id === logId) || logs[0];
  const isGranted = granted(order);
  const isRefunded = refunded(order);
  const cost = estimate?.cost ?? selected?.cost ?? .32;
  const oneoffPrice = estimate?.price ?? selected?.price ?? 2.8;
  const account = data?.account || { credits: 0 };
  const subscribed = account.subscriptionUntil && new Date(account.subscriptionUntil) > new Date();
  const paymentAmount = mode === 'credits' ? account.credits >= 10 ? 0 : 9.9 : mode === 'subscription' ? subscribed ? 0 : 29.9 : oneoffPrice;

  const notify = (message, type = 'success') => {
    setToast({ message, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5500);
  };
  const refresh = async () => { const next = await api('/bootstrap'); setData(next); return next; };
  useEffect(() => { refresh().then(next => setDraft(next.cases[0]?.draft || '')).catch(e => notify(e.message, 'error')); }, []);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId, draft }), signal: controller.signal });
        if (!response.ok) throw new Error('诊断暂时不可用');
        setEstimate(await response.json());
      } catch (error) { if (error.name !== 'AbortError') notify(error.message, 'error'); }
    }, 240);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [caseId, draft, !!selected]);
  useEffect(() => {
    setDelivery(null);
    if (isGranted && orderId) api(`/orders/${orderId}/deliverables`).then(setDelivery).catch(e => notify(e.message, 'error'));
  }, [orderId, isGranted]);
  useEffect(() => {
    if (modal?.type !== 'payment' || !paymentUrl) return;
    QRCode.toDataURL(new URL(paymentUrl, location.origin).href, { width: 200, margin: 1, color: { dark: '#0F1626', light: '#FFFFFF' } }).then(setQr);
  }, [modal?.type, paymentUrl]);

  const pickCase = c => { if (c.id !== caseId || c.draft !== draft) setEstimate(null); setCaseId(c.id); setDraft(c.draft); setOrderId(null); setDelivery(null); setPreviewTab('diagnosis'); };
  const run = async (label, action) => {
    if (busy) return;
    setBusy(label);
    try { await action(); } catch (e) { notify(e.message, 'error'); } finally { setBusy(''); }
  };
  const queryOrder = async (id = orderId) => {
    const result = await api(`/orders/${id}/query`, {});
    await refresh();
    if (refunded(result.order)) notify(result.order.refundReason || 'SLA 保护已执行，交付权限已收回', 'refund');
    else if (granted(result.order)) { notify('支付已确认 · SLA 达标 · 完整交付物已解锁'); setModal(null); }
    else notify('服务端查询：等待买家付款，权益仍处于锁定状态', 'info');
    return result;
  };
  const checkout = (quickUnlock = false) => run('checkout', async () => {
    if (!draft.trim()) throw new Error('请先输入科研或专利草稿');
    const orderMode = quickUnlock ? 'oneoff' : mode;
    if (quickUnlock) setMode('oneoff');
    const result = await api('/orders', { caseId, mode: orderMode, draft, idempotencyKey: unique() });
    setOrderId(result.order.id);
    await refresh();
    if (granted(result.order)) { notify('已使用现有科研权益，完整成果已解锁'); return; }
    if (refunded(result.order)) { notify('SLA 质量未达标，已退回本次权益消耗', 'refund'); return; }
    if (quickUnlock && simulation) {
      await api(`/orders/${result.order.id}/simulate-pay`, {});
      await queryOrder(result.order.id);
      return;
    }
    const url = result.paymentUrl || `/api/payments/${result.order.id}/page`;
    setPaymentUrl(url);
    setModal({ type: 'payment' });
  });
  const simulatePayment = () => run('pay', async () => {
    await api(`/orders/${orderId}/simulate-pay`, {});
    await refresh();
    await queryOrder();
  });
  const replay = id => run(`replay-${id}`, async () => {
    const result = await api(`/orders/${id}/replay`, {});
    await refresh();
    notify(result.duplicate ? '幂等拦截成功：重复回调未重复核销或扣减权益' : '回调已校验，当前订单状态已同步');
  });
  const refund = id => run(`refund-${id}`, async () => {
    await api(`/orders/${id}/refund`, {});
    await refresh();
    if (id === orderId) setDelivery(null);
    notify('退款完成 · 已收回订单下载权益', 'refund');
  });
  const download = async (id, format) => {
    try {
      const response = await fetch(`/api/orders/${id}/download?format=${format}`);
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || '下载未授权'); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = `PaperPatent-${id}.${format}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      notify('交付物已导出，下载权限已由服务端核验');
    } catch (e) { notify(e.message, 'error'); }
  };
  const autoDemo = () => run('autopilot', async () => {
    if (!simulation) throw new Error('真实沙箱需要买家完成支付；自动演练仅用于本地仿真环境');
    const steps = ['创建专利订单', '仿真买家支付', '查询验签与 SLA 核销', '重复回调幂等拦截', '质量不达标自动退款'];
    setAutopilot({ index: 0, steps, done: false });
    const c = cases.find(c => c.id === 'patent');
    pickCase(c); setMode('oneoff');
    const created = await api('/orders', { caseId: c.id, draft: c.draft, mode: 'oneoff', idempotencyKey: unique() });
    setOrderId(created.order.id); await refresh();
    setAutopilot({ index: 1, steps });
    await api(`/orders/${created.order.id}/simulate-pay`, {}); await refresh();
    setAutopilot({ index: 2, steps });
    const success = await api(`/orders/${created.order.id}/query`, {});
    if (!granted(success.order)) throw new Error('专利成果核销未通过');
    await api(`/orders/${created.order.id}/deliverables`); await refresh();
    setAutopilot({ index: 3, steps });
    const duplicate = await api(`/orders/${created.order.id}/replay`, {});
    if (!duplicate.duplicate) throw new Error('重复回调幂等校验失败');
    setAutopilot({ index: 4, steps });
    const bad = cases.find(c => c.id === 'sla');
    const fail = await api('/orders', { caseId: bad.id, draft: bad.draft, mode: 'oneoff', idempotencyKey: unique() });
    await api(`/orders/${fail.order.id}/simulate-pay`, {});
    const refundResult = await api(`/orders/${fail.order.id}/query`, {});
    if (!refunded(refundResult.order)) throw new Error('SLA 自动退款未完成');
    const blocked = await fetch(`/api/orders/${fail.order.id}/deliverables`);
    if (blocked.ok) throw new Error('退款后权限回收检查失败');
    await refresh(); setAutopilot({ index: 5, steps, done: true });
    notify('商业闭环 5/5 通过：专利已解锁，SLA 退款与权限回收已验证');
  });
  const exportReceipt = async o => {
    setModal({ type: 'receipt', order: o });
  };
  const saveReceipt = () => run('receipt', async () => {
    const dataUrl = await toPng(receiptRef.current, { pixelRatio: 2, backgroundColor: '#0F1626', fontEmbedCSS: '' });
    const link = document.createElement('a'); link.download = `凭证-${modal.order.outTradeNo || modal.order.id}.png`; link.href = dataUrl; link.click();
    notify('财务凭证 PNG 已导出');
  });
  const navigate = id => {
    setActiveNav(id);
    if (id === 'ledger') ledgerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (id === 'workspace') window.scrollTo({ top: 0, behavior: 'smooth' });
    if (id === 'inspector') setDrawer(true);
    if (id === 'assets') setModal({ type: 'assets' });
    if (id === 'settings') setModal({ type: 'settings' });
  };
  const experts = estimate?.preview?.experts || [];
  const visibleOrders = orders.filter(o => ledgerFilter === 'all' || (ledgerFilter === 'granted' ? granted(o) : refunded(o)));
  const totalCost = Number(kpis.cost || 0);
  const inlinePaywall = !isGranted && <div className="inline-paywall-cta" aria-label="剩余成果内联解锁收银条">
    <div className="inline-paywall-copy"><LockKeyhole size={17}/><div><strong>剩余 70% 核心成果待解锁</strong><p>{caseId === 'paper' ? '完整精修论文 + Reviewer 回复信' : caseId === 'report' ? '完整结题报告 + 财务预算表' : '完整独立 / 从属权利要求书'} + SVG 说明书附图 + LaTeX / Word 源码包</p></div></div>
    <div className="inline-paywall-actions"><button className="inline-unlock-button" disabled={!!busy || !selected || !draft.trim()} onClick={() => checkout(true)}>{busy === 'checkout' ? <Loader2 size={14} className="spin"/> : <span className="alipay-inline">支</span>}支付宝 ¥{money(oneoffPrice)} 立即解锁并核销<ArrowRight size={13}/></button><button className="inline-checkout-link" onClick={() => { checkoutRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); checkoutRef.current?.focus({ preventScroll: true }); }}>跳转三模收银台<ArrowUpRight size={12}/></button></div>
    <span className="inline-paywall-note"><ShieldCheck size={11}/>{simulation ? '沙箱仿真 · 不产生真实扣款 · 查询与 SLA 达标后解锁' : '确认支付宝支付后，服务端查询与 SLA 达标才解锁'}</span>
  </div>;

  return <div className="app-shell">
    <aside className="rail">
      <button className="brand-mark" aria-label="PaperPatent 首页" onClick={() => navigate('workspace')}><FileText size={24}/><span className="brand-spark">✦</span></button>
      <div className="rail-separator"/>
      <nav>{[{ id: 'workspace', icon: Layers3, label: '科研工作台' }, { id: 'ledger', icon: BarChart3, label: '商业对账' }, { id: 'assets', icon: FolderOpen, label: '交付资产' }, { id: 'inspector', icon: Braces, label: 'API 报文' }].map(n => <button key={n.id} title={n.label} aria-label={n.label} className={`rail-button ${activeNav === n.id ? 'active' : ''}`} onClick={() => navigate(n.id)}><n.icon size={21}/></button>)}</nav>
      <div className="rail-bottom"><button className="rail-button" title="接入配置" aria-label="接入配置" onClick={() => navigate('settings')}><Settings2 size={21}/></button><button className="avatar" title="本地科研工作空间" onClick={() => setModal({ type: 'settings' })}>PP</button></div>
    </aside>

    <div className="app-body">
      <header className="topbar">
        <div className="brand-wordmark">PaperPatent <span className="brand-divider">/</span> <span className="vibepay">VibePay<span className="beta">BETA</span></span></div>
        <div className="header-middle"><span className="workspace-breadcrumb">工作空间</span><ChevronRight size={12}/><span>科研商业工作台</span><span className="header-tag">PAYATHON 2026</span></div>
        <div className="topbar-right"><button className="connection-pill" onClick={() => setModal({ type: 'settings' })}><span className="live-dot"/><span className="alipay-mini">支</span>支付宝 AI 付 <span className="connection-label">{simulation ? '沙箱仿真已连接' : '开放平台沙箱'}</span><ChevronDown size={12}/></button><span className="topbar-line"/><button className="icon-button notification" aria-label="查看运行消息" onClick={() => { setDrawer(true); }}><Bell size={18}/><i/></button><div className="user-chip">研</div></div>
      </header>

      <main>
        <section className="page-heading"><div><div className="eyebrow"><span/> RESEARCH TO VALUE, IN ONE FLOW</div><h1>让科研成果，<span>即刻产生价值。</span></h1><p>从草稿到高质量交付，让每一份价值被看见、被验证、被支付。</p></div><div className="heading-actions"><div className="environment-label"><span className="live-dot"/> SYSTEM OPERATIONAL <span className="version">v1.0.0</span></div><button className="autopilot-button" disabled={!!busy} onClick={autoDemo}>{busy === 'autopilot' ? <Loader2 size={15} className="spin"/> : <Play size={14} fill="currentColor"/>}一键评委全链路商业演练<ArrowUpRight size={15}/></button><span className="button-caption">1-CLICK VIBEPAY AUTO-PILOT</span></div></section>

        <section className="kpi-grid">
          <div className="kpi-card"><div className="kpi-label"><span>01 // GROSS GMV</span><CircleDollarSign size={15}/></div><div className="kpi-content"><div className="kpi-value"><small>¥</small>{money(kpis.gmv)}</div><Sparkline/></div><div className="kpi-footer"><span>累计实收金额</span><span className="blue-text">{kpis.paidOrders || 0} 笔已支付 <ArrowUpRight size={11}/></span></div></div>
          <div className="kpi-card"><div className="kpi-label"><span>02 // AI TOKEN COST & MARGIN</span><AudioLines size={15}/></div><div className="kpi-content"><div className="kpi-value"><small>¥</small>{money(totalCost)}<span className="margin-number">{kpis.margin == null ? '—' : Number(kpis.margin).toFixed(1)}<small>%</small></span></div><Sparkline color="#10b981" variant={1}/></div><div className="kpi-footer"><span>实时算力成本 / 毛利率</span><span className="green-text">{env?.aiMode === 'live' ? '在线模型计量' : '演示模型计量'}</span></div></div>
          <div className="kpi-card"><div className="kpi-label"><span>03 // ENTITLEMENT PASS RATE</span><Fingerprint size={15}/></div><div className="kpi-content"><div className="kpi-value">{Number(kpis.passRate || 0).toFixed(1)}<small>%</small></div><Sparkline color="#8b8aff" variant={2}/></div><div className="kpi-footer"><span>权益核销放行率</span><span className="violet-text"><ShieldCheck size={11}/>服务端严格核验</span></div></div>
          <div className="kpi-card"><div className="kpi-label"><span>04 // SLA AUTO-REFUND GUARD</span><ShieldCheck size={15}/></div><div className="kpi-content"><div className="kpi-value">{kpis.refunds || 0}<small className="unit-word">笔</small></div><Sparkline color="#f59e0b" variant={3}/></div><div className="kpi-footer"><span>质量不达标自动退款</span><span className="amber-text"><span className="tiny-dot"/>保护已开启</span></div></div>
        </section>

        <section className="cases-section"><div className="section-title-row"><h2><Boxes size={15}/>快速启动案卷<span className="section-subtitle">PRESET CASE FILES</span></h2><span className="quiet-label">4 个精选场景 · 5 秒开始体验</span></div><div className="case-grid">{cases.map((c, i) => { const Icon = icons[i]; return <button key={c.id} className={`case-card ${caseId === c.id ? 'selected' : ''} ${c.id === 'sla' ? 'sla-case' : ''}`} onClick={() => pickCase(c)}><span className="case-icon"><Icon size={19}/></span><div className="case-copy"><span className="case-kicker">案卷 {c.number || `0${i + 1}`}<span>{c.id === 'sla' ? 'SLA 压测' : i === 0 ? 'PATENT' : i === 1 ? 'RESEARCH' : 'PROJECT'}</span></span><strong>{['发明专利交底书精修', 'SCI 论文与审稿回复', '大创结题与财务预算', 'SLA 质量对赌演练'][i]}</strong><span className="case-description">{['高压压裂车 · 自适应降噪控制', '锂电池寿命预测 · Reviewer #2', '智能医疗 · 无障碍辅助系统', '58 分草稿 · 全额自动退款'][i]}</span></div><span className="case-price">{i === 3 ? <ShieldCheck size={15}/> : `¥${money(c.price)}`}</span>{caseId === c.id && <span className="case-active-dot"/>}</button>; })}</div></section>

        <section className="workspace-grid" id="workspace">
          <div className="panel input-panel"><div className="panel-heading"><div className="panel-title"><span className="step-number">01</span><h2>草稿诊断台</h2></div><span className="small-tag"><span className="live-dot"/>免费试读</span></div>
            <div className="input-toolbar"><span><FileText size={13}/>研究草稿</span><button onClick={() => fileRef.current?.click()}><Plus size={12}/>导入文本</button><input ref={fileRef} type="file" accept=".txt,.md,.tex" hidden onChange={async e => { const file = e.target.files?.[0]; if (file) { setDraft(await file.text()); setOrderId(null); notify('草稿已导入，正在更新诊断和成本估算'); } e.target.value = ''; }}/></div>
            <div className="draft-title"><span className="document-type">{caseId === 'paper' ? 'SCI' : caseId === 'report' ? 'REPORT' : 'PATENT'}</span><h3>{selected?.title || '正在加载科研案卷…'}</h3></div>
            <textarea className="draft-editor" aria-label="研究草稿输入" value={draft} onChange={e => { setDraft(e.target.value); setOrderId(null); }} placeholder="在此输入专利技术方案、论文摘要或研究草稿…" spellCheck={false}/>
            <div className="editor-footer"><span><span className="tiny-dot"/>草稿已在本地工作台加载</span><span>{estimate?.chars ?? draft.length} 字</span></div>
            <div className="meter-section"><div className="meter-heading"><span><Gauge size={14}/>实时 AI 任务计量</span><span className="meter-live">LIVE ESTIMATE</span></div><div className="token-grid"><div><span>PROMPT TOKENS</span><strong>{(estimate?.promptTokens || 0).toLocaleString()}<small> tokens</small></strong></div><div><span>COMPLETION TOKENS</span><strong>~{(estimate?.completionTokens || 0).toLocaleString()}<small> tokens</small></strong></div></div><div className="cost-track"><span style={{ width: `${Math.min(cost / .45 * 100, 100)}%` }}/></div><div className="cost-detail"><span>预估模型调用成本</span><strong>¥{money(cost)}<small> / 次</small></strong></div><div className="pricing-summary"><div><span>建议按果定价</span><strong>¥{money(oneoffPrice)}</strong></div><span className="pricing-arrow"><ArrowRight size={15}/></span><div className="right-aligned"><span>预计单次毛利率</span><strong className="green-text">{Number(estimate?.margin ?? 88.6).toFixed(1)}<small>%</small></strong></div></div></div>
            <button className="secondary-button diagnose-button" disabled={!!busy || !draft.trim()} onClick={() => run('diagnose', async () => { setEstimate(await api('/estimate', { caseId, draft })); setPreviewTab('diagnosis'); notify('三位专家初审诊断已更新'); })}><Sparkles size={14}/>{busy === 'diagnose' ? '正在诊断…' : '重新运行免费诊断'}<span>FREE</span></button>
          </div>

          <div className="panel delivery-panel"><div className="panel-heading"><div className="panel-title"><span className="step-number">02</span><h2>AI 成果交付</h2></div><span className={`small-tag ${isGranted ? 'green-tag' : 'blue-tag'}`}>{isGranted ? <CheckCheck size={12}/> : <Sparkles size={12}/>} {isGranted ? '完整交付已解锁' : '3 位专家协同'}</span></div>
            <div className="preview-tabs"><button className={previewTab === 'diagnosis' ? 'active' : ''} onClick={() => setPreviewTab('diagnosis')}>专家初审<span>03</span></button><button className={previewTab === 'claims' ? 'active' : ''} onClick={() => setPreviewTab('claims')}>{caseId === 'paper' ? '论文与回复' : caseId === 'report' ? '结题报告' : '权利要求书'}{!isGranted && <LockKeyhole size={11}/>}</button><button className={previewTab === 'diagram' ? 'active' : ''} onClick={() => setPreviewTab('diagram')}>架构附图{!isGranted && <LockKeyhole size={11}/>}</button><button aria-label="展开成果" className="expand-preview" onClick={() => isGranted ? setModal({ type: 'delivery' }) : notify('完成支付和 SLA 核验后即可查看完整成果', 'info')}><Maximize2 size={13}/></button></div>
            <div className="delivery-scroll">
              {previewTab !== 'diagnosis' && inlinePaywall}
              {previewTab === 'diagnosis' && <><div className="preview-note"><span className="tiny-dot"/>免费诊断已生成<span>前 30% 价值预览</span></div><div className="experts-list">{experts.length ? experts.map((expert, i) => <div className={`expert-row expert-${i}`} key={i}><div className="expert-avatar">{[<FileCheck2 size={16}/>, <FlaskConical size={16}/>, <CircleDollarSign size={16}/>][i]}</div><div className="expert-content"><div><strong>{expert.role}</strong><span>{['TECHNICAL REVIEW', 'ACADEMIC REVIEW', 'VALUE ASSESSMENT'][i]}</span><Check size={12}/></div><p>{expert.body}</p></div></div>) : <div className="diagnosis-loading"><Loader2 className="spin" size={18}/>正在分析科研草稿…</div>}</div>{inlinePaywall}<div className="outline-heading"><span><Workflow size={13}/>核心交付大纲</span><span className="quiet-label">STRUCTURED OUTPUT</span></div><div className="outline-list">{(estimate?.preview?.outline || ['技术领域与背景技术', '核心技术方案及权利要求', '实施方式与系统架构']).slice(0, 3).map((item, i) => <div key={i}><span>0{i + 1}</span>{item.replace(/^\d+\s*[·.、]\s*/, '')}<Check size={12}/></div>)}</div></>}
              {isGranted && previewTab === 'diagram' ? <div className="unlocked-diagram"><div className="diagram-label"><CheckCheck size={13}/>已通过 SLA 质量核验 · 原始 SVG</div><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(delivery?.svg || '')}`} alt="科研交付架构图"/><button className="secondary-button" onClick={() => download(orderId, 'svg')}><Download size={13}/>下载 SVG 矢量附图</button></div> : isGranted && previewTab === 'claims' ? <div className="unlocked-copy"><div className="diagram-label"><CheckCheck size={13}/>完整成果 · 已核销</div><pre>{delivery?.markdown || '交付物正在生成…'}</pre></div> : <div className={`paywall-area ${previewTab !== 'diagnosis' ? 'large-paywall' : ''} ${isGranted ? 'is-unlocked' : ''}`}><div className="paywall-background" aria-hidden="true"><div className="mock-document-heading">{caseId === 'paper' ? 'RESPONSE TO REVIEWER #2' : '独立权利要求与从属权利要求'}</div><div className="mock-line long"/><div className="mock-line"/><div className="mock-line medium"/><div className="mock-line long"/><div className="mock-line"/><div className="mock-diagram"><div>传感器采集</div><ArrowRight size={14}/><div>自适应模型</div><ArrowRight size={14}/><div>决策控制</div></div></div><div className="paywall-content"><div className="lock-orbit">{isGranted ? <BadgeCheck size={20}/> : isRefunded ? <ShieldX size={19}/> : <LockKeyhole size={19}/>}</div><strong>{isGranted ? '完整成果已准备就绪' : isRefunded ? 'SLA 退款保护已执行' : '好成果，值得一份确定的交付'}</strong><p>{isGranted ? '已通过支付核验与质量审查，随时下载完整交付包' : isRefunded ? '已原路全额退款，下载权益已自动收回' : caseId === 'paper' ? '解锁精修论文、审稿回复与可编辑文档' : caseId === 'report' ? '解锁完整结题报告、财务预算与验收清单' : '解锁完整权利要求、架构附图与可编辑文档'}</p><div className="file-tags"><span><FileText size={11}/>Word</span><span><FileCode2 size={11}/>LaTeX</span><span><Workflow size={11}/>SVG</span></div>{isGranted && <button className="unlocked-view-button" onClick={() => setModal({ type: 'delivery' })}>查看完整成果<ArrowUpRight size={13}/></button>}</div></div>}
            </div><div className="delivery-bottom"><span><ShieldCheck size={13}/>服务端验权 · SLA ≥ 85 分才交付</span><button disabled={!isGranted} onClick={() => download(orderId, 'zip')}><Download size={13}/>导出交付包</button></div>
          </div>

          <div className="panel checkout-panel" ref={checkoutRef} tabIndex={-1}><div className="panel-heading"><div className="panel-title"><span className="step-number">03</span><h2>Vibe Pay 收银台</h2></div><span className="alipay-badge">支</span></div><div className="payment-mode-tabs">{[{ id: 'oneoff', icon: CreditCard, label: '按果买断' }, { id: 'credits', icon: Coins, label: '算力包' }, { id: 'subscription', icon: Zap, label: 'Pro 订阅' }].map(m => <button className={mode === m.id ? 'active' : ''} key={m.id} onClick={() => { setMode(m.id); setOrderId(null); }}><m.icon size={13}/>{m.label}</button>)}</div>
            <div className="checkout-description"><span>{mode === 'oneoff' ? 'PAY PER RESULT' : mode === 'credits' ? 'RESEARCH CREDITS PACK' : 'PRO MONTHLY ACCESS'}</span><h3>{mode === 'oneoff' ? '只为这一份好成果付费' : mode === 'credits' ? '为持续科研，储备一点算力' : '让每一次灵感，拥有 Pro 实力'}</h3><div className="checkout-price"><small>¥</small>{money(paymentAmount)}<span> / {mode === 'oneoff' ? '次交付' : mode === 'credits' ? account.credits >= 10 ? '使用现有积分' : '100 算力点' : subscribed ? '会员权益内' : '月'}</span>{mode === 'oneoff' && <span className="price-tag">无隐藏费用</span>}</div><p>{mode === 'oneoff' ? '一次支付，获得本案卷完整成果与全部导出格式。' : mode === 'credits' ? `当前余额 ${account.credits} 点 · 每案消耗 10 点 · 幂等扣减` : `30 天科研权益${subscribed ? ' · 当前会员已生效' : ' · 预付月卡，手动续费'}`}</p></div>
            <div className="checkout-inclusions"><div><Check size={12}/>三位 AI 专家完整诊断报告</div><div><Check size={12}/>{caseId === 'paper' ? '精修论文与逐条 Reviewer 回复' : caseId === 'report' ? '结题文档与逐项财务预算' : '独立 / 从属权利要求与技术说明'}</div><div><Check size={12}/>Word + LaTeX + SVG 完整交付包</div></div>
            <button className={`pay-button ${isGranted ? 'paid' : ''}`} disabled={!!busy || !selected || isGranted} onClick={() => checkout()}>{busy === 'checkout' || busy === 'pay' ? <Loader2 size={16} className="spin"/> : isGranted ? <CheckCheck size={16}/> : <span className="alipay-inline">支</span>}{isGranted ? '已核销 · 成果已解锁' : paymentAmount === 0 ? '使用现有权益解锁' : `支付宝支付 ¥${money(paymentAmount)}`}{!isGranted && <ArrowRight size={15}/>}</button>
            <div className="payment-safety"><LockKeyhole size={10}/>RSA2 加密验签<span>·</span>支付后核验解锁</div>
            <div className="state-machine"><div className="state-heading"><span><Workflow size={13}/>严格权益核销状态机</span><span>LIVE</span></div>{[{ title: '订单创建', code: 'WAIT_BUYER_PAY', active: !!order }, { title: '支付宝扫码 / 沙箱支付', code: 'BUYER PAYMENT', active: !!order && order.tradeStatus === 'TRADE_SUCCESS' || isGranted || isRefunded }, { title: '服务端查询与 RSA2 验签', code: 'TRADE_SUCCESS', active: isGranted || isRefunded }, { title: 'AI 交付质量 SLA 校验', code: isRefunded ? `${order?.qualityScore ?? 0} / 100 · 权限已回收` : isGranted ? `${order.qualityScore || 94} / 100 ≥ 85` : 'QUALITY SCORE ≥ 85', active: isGranted || isRefunded }, { title: isRefunded ? '质量未达标 · 全额退款' : '权益放行 · 解锁完整成果', code: isRefunded ? 'REFUND_SUCCESS' : 'ENTITLEMENT_GRANTED', active: isGranted || isRefunded }].map((step, i) => <div key={i} className={`state-step ${step.active ? 'completed' : ''} ${isRefunded && i === 4 ? 'refunded' : ''}`}><span className="state-dot">{step.active ? <Check size={10}/> : `0${i + 1}`}</span><div><span>{step.title}</span><small>{step.code}</small></div>{step.active && <span className="step-ok">{isRefunded && i === 4 ? 'REFUNDED' : 'OK'}</span>}</div>)}</div>
            <div className="sla-protection"><ShieldCheck size={16}/><div><strong>质量不达标？自动全额退款。</strong><span>SLA 质量对赌保护 · 权益同步收回</span></div><CircleHelp size={12}/></div>
          </div>
        </section>

        <section className="ledger-section panel" ref={ledgerRef}><div className="ledger-heading"><div><h2><BarChart3 size={16}/>商业对账与毛利核算<span className="section-subtitle">RECONCILIATION & MARGIN LEDGER</span></h2><p>每一笔支付、每一次核销、每一分算力成本，都有据可查。</p></div><div className="ledger-actions"><span className="live-ledger"><span className="live-dot"/>实时同步</span><button className="secondary-button" onClick={() => { setDrawer(true); setActiveNav('inspector'); }}><Terminal size={13}/>API 报文检视器<ArrowUpRight size={12}/></button></div></div><div className="ledger-filter-row"><div className="ledger-tabs">{[{ id: 'all', label: '全部交易', count: orders.length }, { id: 'granted', label: '已核销', count: orders.filter(granted).length }, { id: 'refunded', label: '已退款', count: orders.filter(refunded).length }].map(f => <button key={f.id} className={ledgerFilter === f.id ? 'active' : ''} onClick={() => setLedgerFilter(f.id)}>{f.label}<span>{f.count}</span></button>)}</div><span className="ledger-note"><ShieldCheck size={11}/>重复通知幂等保护已开启</span></div><div className="table-scroll"><table><thead><tr><th>商户订单号 / 支付宝交易号</th><th>付费模式</th><th className="numeric">实收金额</th><th className="numeric">AI Token 成本</th><th className="numeric">单笔净利润 / 毛利率</th><th>权益核销状态</th><th className="actions-th">快捷操作</th></tr></thead><tbody>{visibleOrders.length ? visibleOrders.map(o => <tr key={o.id}><td className="order-ids"><strong>{o.outTradeNo || o.id}</strong><span>{o.tradeNo || '等待支付宝生成交易号'}</span></td><td><span className={`mode-tag mode-${o.mode}`}>{modeNames[o.mode] || o.mode}</span></td><td className="numeric amount-cell">¥{money(received(o))}</td><td className="numeric muted">¥{money(o.cost)}</td><td className={`numeric profit-cell ${refunded(o) ? 'rose-text' : 'green-text'}`}>¥{money(o.profit ?? (received(o) - (o.cost || 0)))}<span>{Number(o.margin || 0).toFixed(1)}%</span></td><td><span className={`status-pill ${granted(o) ? 'success' : refunded(o) ? 'refund' : 'pending'}`}><span className="tiny-dot"/>{granted(o) ? '已核销放行' : refunded(o) ? '已退款 · 权益回收' : '等待支付核验'}</span></td><td><div className="row-actions"><button title="查询核销" aria-label="查询核销" disabled={!!busy} onClick={() => run(`query-${o.id}`, () => { const c = cases.find(c => c.id === o.caseId); if (c && c.id !== caseId) pickCase(c); setMode(o.mode); setOrderId(o.id); return queryOrder(o.id); })}><RefreshCw size={13}/></button><button title="模拟重复回调幂等拦截" aria-label="模拟重复回调幂等拦截" disabled={!!busy || !o.tradeNo} onClick={() => replay(o.id)}><Copy size={13}/></button><button title="一键发起 SLA 退款" aria-label="一键发起 SLA 退款" disabled={!!busy || !granted(o)} onClick={() => refund(o.id)}><ShieldX size={13}/></button><button title="导出财务凭证 PNG" aria-label="导出财务凭证 PNG" onClick={() => exportReceipt(o)}><ArrowDownToLine size={13}/></button></div></td></tr>) : <tr><td colSpan={7}><div className="empty-ledger"><div><FileCheck2 size={20}/></div><span>{ledgerFilter === 'all' ? '你的第一笔科研价值，即将在这里发生' : '当前筛选条件下暂无交易'}</span><small>{ledgerFilter === 'all' ? '选择一个案卷开始体验，或运行「一键评委全链路商业演练」' : '切换到全部交易查看完整记录'}</small></div></td></tr>}</tbody></table></div><div className="ledger-footer"><span><LockKeyhole size={11}/>金额与权益由服务端核验 · 本地 SQLite 持久化</span><span>{orders.length} RECORDS<span className="footer-separator">/</span>CNY ¥</span></div></section>
        <footer className="page-footer"><div><span className="footer-logo">✦</span>PaperPatent VibePay<span>让知识被尊重，让价值有回响。</span></div><div><span className="tiny-dot"/>{simulation ? '本地 RSA2 沙箱仿真' : '支付宝开放平台沙箱'}<span>·</span>{env?.aiMode === 'live' ? '在线 AI 模型' : '预设内容演示引擎'}<a href="https://aipay.alipay.com/docs/vibe-pay.html" target="_blank" rel="noreferrer">支付宝 AI 付文档<ArrowUpRight size={11}/></a></div></footer>
      </main>
    </div>

    {toast && <div className={`toast toast-${toast.type}`} role="status">{toast.type === 'error' || toast.type === 'refund' ? <ShieldX size={17}/> : toast.type === 'info' ? <Activity size={17}/> : <CheckCheck size={17}/>}<span>{toast.message}</span><button aria-label="关闭通知" onClick={() => setToast(null)}><X size={14}/></button></div>}
    {autopilot && <div className="autopilot-progress"><div><span className="live-dot"/><strong>VibePay 商业演练</strong><span className="progress-count">{Math.min(autopilot.index + 1, 5)}/5</span>{autopilot.done && <button aria-label="关闭演练结果" onClick={() => setAutopilot(null)}><X size={14}/></button>}</div><div className="autopilot-track"><span style={{ width: `${autopilot.done ? 100 : (autopilot.index + 1) * 20}%` }}/></div><p>{autopilot.done ? '全链路通过 · 交付已解锁，退款权限回收已验证' : autopilot.steps[autopilot.index]}</p>{autopilot.done && <div className="autopilot-checks">{autopilot.steps.map(s => <span key={s}><Check size={11}/>{s}</span>)}</div>}</div>}

    {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)}><aside className="inspector-drawer" onClick={e => e.stopPropagation()}><div className="drawer-heading"><div className="drawer-icon"><Braces size={20}/></div><div><span>DEVELOPER OBSERVABILITY</span><h2>支付宝 API 实时检视器</h2></div><button className="icon-button" aria-label="关闭报文检视器" onClick={() => setDrawer(false)}><PanelRightClose size={19}/></button></div><div className="inspector-status"><span className="live-dot"/>{simulation ? 'LOCAL SIMULATOR' : 'ALIPAY SANDBOX'}<span>RSA2 / SHA256WITHRSA</span></div><div className="log-list">{logs.length ? logs.map(log => <button className={currentLog?.id === log.id ? 'selected' : ''} key={log.id} onClick={() => setLogId(log.id)}><span className={`log-method-icon ${log.method?.includes('refund') ? 'rose-text' : ''}`}>{log.method?.includes('refund') ? <ShieldX size={13}/> : <ArrowUpRight size={13}/>}</span><div><strong>{log.method}</strong><span>{new Date(log.time || log.createdAt).toLocaleTimeString('zh-CN')}<span>{log.mode || env?.mode}</span></span></div><span className="log-code">{log.verified === false ? 'FAIL' : 'RSA2'}</span><ChevronRight size={12}/></button>) : <div className="empty-inspector"><Terminal size={28}/><strong>等待第一笔 API 调用</strong><p>创建订单后，真实请求载荷、签名及响应会出现在这里。</p></div>}</div>{currentLog && <><div className="signature-summary"><div><span>幂等键 IDEMPOTENCY KEY</span><code>{currentLog.idempotencyKey || '—'}</code></div><div><span>RSA2 签名摘要</span><code>{currentLog.signatureDigest || currentLog.request?.sign?.slice(0, 48) || '—'}</code></div><div className={currentLog.verified === false ? 'rose-text' : 'green-text'}><ShieldCheck size={12}/>{currentLog.verified === false ? '验签未通过' : '签名生成 / 响应验签通过'}</div></div><div className="json-tabs"><button className={logTab === 'request' ? 'active' : ''} onClick={() => setLogTab('request')}>Request Payload</button><button className={logTab === 'response' ? 'active' : ''} onClick={() => setLogTab('response')}>Response JSON</button><button className="copy-json" title="复制 JSON" onClick={async () => { await navigator.clipboard.writeText(JSON.stringify(currentLog[logTab], null, 2)); notify('JSON 报文已复制'); }}><Copy size={13}/></button></div><pre className="json-view">{JSON.stringify(currentLog[logTab], null, 2)}</pre></>}<div className="inspector-footer"><ShieldCheck size={12}/>私钥仅保留在服务端，面板不展示密钥材料</div></aside></div>}

    {modal && <div className="modal-backdrop" onClick={() => setModal(null)}><section className={`modal modal-${modal.type}`} role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}><button className="modal-close icon-button" aria-label="关闭弹窗" onClick={() => setModal(null)}><X size={19}/></button>
      {modal.type === 'payment' && <><div className="payment-modal-logo"><span className="alipay-badge">支</span><span>支付宝 {simulation ? '沙箱仿真收银台' : '开放平台沙箱收银台'}</span></div><h2>为确定的成果，付一小步。</h2><p className="modal-subtitle">{selected?.shortTitle || selected?.title}</p><div className="modal-price"><small>¥</small>{money(order?.amount ?? paymentAmount)}</div>{qr && <div className="qr-wrap"><img src={qr} alt={simulation ? '本地仿真支付页面二维码（非支付宝收款码）' : '支付宝沙箱收银页面链接二维码'}/></div>}<div className="qr-caption">{simulation ? '本地支付页面链接 · 非真实收款二维码' : '使用支付宝沙箱客户端或打开沙箱收银页面'}</div><div className="payment-modal-warning"><ShieldCheck size={15}/><span>支付返回页面不会解锁成果。服务端确认交易成功并完成 SLA 校验后，才授予下载权益。</span></div>{simulation ? <button className="pay-button" disabled={!!busy} onClick={simulatePayment}>{busy === 'pay' ? <Loader2 size={16} className="spin"/> : <ScanLine size={16}/>}仿真支付并由服务端查询核销</button> : <a className="pay-button" href={paymentUrl} target="_blank" rel="noreferrer">打开支付宝沙箱收银台<ArrowUpRight size={15}/></a>}<button className="secondary-button query-payment-button" disabled={!!busy} onClick={() => run('query', () => queryOrder())}><RefreshCw size={13}/>我已完成支付，查询订单状态</button><div className="modal-order-id">{order?.outTradeNo || orderId}</div></>}
      {modal.type === 'settings' && <><div className="modal-eyebrow"><Settings2 size={16}/>CONNECTION SETTINGS</div><h2>支付与模型接入配置</h2><p className="modal-subtitle">私钥通过服务端环境变量配置，保存后重启服务生效。</p><div className="settings-status"><span className="live-dot"/>{simulation ? '当前运行：本地 RSA2 签名仿真引擎' : '当前运行：支付宝开放平台沙箱'}</div><div className="setting-row"><span>Gateway</span><code>{env?.gateway || 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'}</code></div><div className="setting-row"><span>App ID</span><code>{env?.appId || 'SIMULATOR · 无需凭证即可演练'}</code></div><div className="settings-code"><code>ALIPAY_APP_ID=你的沙箱应用ID<br/>ALIPAY_PRIVATE_KEY=应用RSA2私钥<br/>ALIPAY_PUBLIC_KEY=支付宝公钥<br/>ALIPAY_NOTIFY_URL=公网HTTPS通知地址<br/>ALIPAY_RETURN_URL=http://localhost:3002/api/alipay/return<br/><br/>AI_API_KEY=可选：在线模型密钥<br/>AI_BASE_URL=https://api.openai.com/v1<br/>AI_MODEL=gpt-4.1-mini</code></div><p className="configuration-note">完整示例见项目 .env.example。Pro 为应用管理的 30 天预付权益；自动扣款需另行签约代扣能力。本地演示使用预设科研内容，不代表官方沙箱认证。</p><a className="secondary-button" href="https://aipay.alipay.com/docs/vibe-pay.html" target="_blank" rel="noreferrer">查看支付宝官方接入文档<ArrowUpRight size={14}/></a></>}
      {modal.type === 'delivery' && <><div className="modal-eyebrow"><BadgeCheck size={16}/>ENTITLEMENT GRANTED</div><h2>{delivery?.title || '完整科研交付物'}</h2><div className="delivery-modal-actions">{['docx', 'tex', 'svg', 'zip'].map(format => <button className="secondary-button" key={format} onClick={() => download(orderId, format)}><Download size={12}/>{format === 'zip' ? '全部打包' : format.toUpperCase()}</button>)}</div><div className="delivery-engine-note">{delivery?.engine === 'live' ? '在线 AI 模型生成' : '预设科研内容演示 · 请结合真实实验与技术资料复核'}</div><pre className="full-document">{delivery?.markdown || '正在加载完整交付物…'}</pre></>}
      {modal.type === 'assets' && <><div className="modal-eyebrow"><FolderOpen size={16}/>RESEARCH ASSETS</div><h2>我的交付资产</h2><p className="modal-subtitle">仅展示支付核验与 SLA 审查通过的可下载成果。</p><div className="asset-list">{orders.filter(granted).length ? orders.filter(granted).map(o => <div key={o.id}><FileCheck2 size={22}/><div><strong>{cases.find(c => c.id === o.caseId)?.title}</strong><span>{o.outTradeNo || o.id}</span></div><button className="secondary-button" onClick={() => download(o.id, 'zip')}><Download size={13}/>下载</button></div>) : <div className="empty-inspector"><LockKeyhole size={26}/><p>完成首个案卷支付后，在这里管理你的科研资产。</p></div>}</div></>}
      {modal.type === 'receipt' && <><div ref={receiptRef} className="receipt"><div className="receipt-brand"><FileCheck2 size={24}/>PaperPatent<span>VibePay</span></div><div className="receipt-heading"><span>FINANCIAL RECEIPT</span><h2>科研成果交易凭证</h2></div><div className="receipt-amount"><small>实收金额 CNY</small><strong>¥{money(received(modal.order))}</strong></div>{[['商户订单号', modal.order.outTradeNo || modal.order.id], ['支付宝交易号', modal.order.tradeNo || '未支付'], ['付费模式', modeNames[modal.order.mode]], ['AI Token 成本', `¥${money(modal.order.cost)}`], ['退款金额', `¥${money(modal.order.refundedAmount)}`], ['权益状态', refunded(modal.order) ? 'REFUND_SUCCESS · 已收回' : granted(modal.order) ? 'ENTITLEMENT_GRANTED' : 'WAIT_BUYER_PAY'], ['创建时间', new Date(modal.order.createdAt).toLocaleString('zh-CN')]].map(([key, value]) => <div className="receipt-row" key={key}><span>{key}</span><strong>{value}</strong></div>)}<div className="receipt-footer"><ShieldCheck size={13}/>{simulation ? '本地仿真交易凭证 · 不作为真实支付或税务凭据' : '支付宝开放平台沙箱凭证 · 非税务发票'}</div></div><button className="pay-button" disabled={!!busy} onClick={saveReceipt}><Download size={15}/>导出财务凭证 PNG</button></>}
    </section></div>}
  </div>;
}

export default App;
