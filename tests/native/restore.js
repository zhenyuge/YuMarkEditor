const jd = window.__jd
return 'docs=' + jd.docs.length + ' | ' + jd.docs.map(d => d.title + ':' + JSON.stringify(d.text()) + ':dirty=' + d.dirty).join(' | ')
