/** The raw request and reply of one row of Monitor > Recent requests, as the engine server received and answered it. */
import { useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/client';
import type { ServeRequest } from '../lib/types';
import { CopyBtn } from './CopyBtn';
import { Dialog } from './ui';

interface RawRecord { input?: string; input_truncated?: boolean; output?: string; output_truncated?: boolean; reasoning?: string; reasoning_truncated?: boolean; response?: string; response_truncated?: boolean; [key: string]: unknown }
type Loaded = { status: 'ok'; record: RawRecord } | { status: 'gone' | 'unavailable' | 'off' | 'loading' };
const TEXT_FIELDS = ['input', 'output', 'reasoning', 'response'];

function Raw({ title, text, cut }: { title: string; text: string; cut?: boolean }) {
    return <section><div className="section-toolbar"><h3 className="h4">{tr(title)}</h3><CopyBtn text={text} label={title} title="Copy message"/></div>
      {cut ? <p className="small muted">{tr("Only the first 262,144 characters were kept.")}</p> : null}
      <pre className="native-log" dir="ltr">{text}</pre></section>;
}

export function RequestRecord({ request, onClose }: { request: ServeRequest; onClose: () => void }) {
    const { apiRequestId, instanceId } = request;
    const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
    useEffect(() => {
        if (!apiRequestId) { setLoaded({ status: 'off' }); return; }
        const abort = new AbortController();
        setLoaded({ status: 'loading' });
        api.get<Loaded>(`/api/native/request-record?instanceId=${encodeURIComponent(instanceId ?? '')}&id=${encodeURIComponent(apiRequestId)}`, abort.signal)
            .then(value => { if (!abort.signal.aborted) setLoaded(value); })
            .catch(() => { if (!abort.signal.aborted) setLoaded({ status: 'unavailable' }); });
        return () => abort.abort();
    }, [apiRequestId, instanceId]);
    const record = loaded.status === 'ok' ? loaded.record : null;
    const rest = record ? Object.fromEntries(Object.entries(record).filter(([key]) => !TEXT_FIELDS.includes(key))) : null;
    return <Dialog open wide title={tr("Request details")} onClose={onClose}>
      {record ? <div className="stack stack--lg">
        <Raw title="Request" text={record.input ?? ''} cut={record.input_truncated}/>
        {record.reasoning ? <Raw title="Reasoning" text={record.reasoning} cut={record.reasoning_truncated}/> : null}
        {record.output ? <Raw title="Response" text={record.output} cut={record.output_truncated}/> : null}
        {record.response ? <Raw title="Raw response" text={record.response} cut={record.response_truncated}/> : null}
        <Raw title="Details" text={JSON.stringify(rest, null, 2)}/>
      </div> : <p role="status">{tr(loaded.status === 'loading' ? 'Loading…'
            : loaded.status === 'off' ? 'This request’s content was not kept. The last 100 requests stay in memory only, until the model is unloaded.'
            : loaded.status === 'gone' ? 'This request’s content is no longer in memory.' : 'The engine did not answer. Try again in a moment.')}</p>}
    </Dialog>;
}
