#let data = json(sys.inputs.data)
#let doc = data.at("doc")
#let fmt = data.at("format")

#let paper = if fmt.pageSize == "Letter" { "us-letter" } else { "a4" }
#let accent = rgb(fmt.accent)
#let muted = rgb("#6b7280")
#let ink = rgb("#111827")
#let body-size = fmt.fontSize * 1pt

#set document(title: doc.title)
#set page(
  paper: paper,
  margin: (x: 20mm, y: 22mm),
  header: context {
    if fmt.header != "" and (not fmt.cover or counter(page).get().first() > 1) {
      align(right, text(size: 0.85em, fill: muted, fmt.header))
    }
  },
  footer: context {
    if not fmt.cover or counter(page).get().first() > 1 {
      align(right, text(size: 0.85em, fill: muted, counter(page).display("1 / 1", both: true)))
    }
  }
)

#set text(
  font: ("Noto Sans", "Noto Sans CJK SC"),
  size: body-size,
  fill: ink
)
#set par(leading: 0.65em, spacing: 0.9em)
#set enum(spacing: 0.6em)
#set list(spacing: 0.5em)

#show heading.where(level: 1): it => {
  set text(size: 1.3em, fill: accent, weight: "bold")
  block(above: 1.5em, below: 0.7em, sticky: true)[
    #it.body
    #v(0.2em, weak: true)
    #line(length: 100%, stroke: 0.75pt + accent)
  ]
}

#let render-body(body) = {
  let normalized = body.replace("\r\n", "\n")
  for raw-block in normalized.split(regex("\n[ \t]*\n")) {
    let block-text = raw-block.trim()
    if block-text == "" { continue }
    let bullets = ()
    let para = ()
    for raw-line in block-text.split("\n") {
      let line = raw-line.trim()
      if line == "" { continue }
      if line.starts-with("- ") {
        if para.len() > 0 {
          par(text(para.join(" ")))
          para = ()
        }
        let item = line.slice(2).trim()
        if item != "" {
          bullets.push(text(item))
        }
      } else {
        if bullets.len() > 0 {
          list(..bullets)
          bullets = ()
        }
        para.push(line)
      }
    }
    if para.len() > 0 {
      par(text(para.join(" ")))
    }
    if bullets.len() > 0 {
      list(..bullets)
    }
  }
}

#if fmt.cover [
  #v(1fr)
  #if fmt.header != "" [
    #text(size: 0.95em, weight: "bold", fill: accent, fmt.header)
    #v(0.8em)
  ]
  #text(size: 2.1em, weight: "bold", fill: accent, doc.title)
  #v(0.6em)
  #line(length: 100%, stroke: 2pt + accent)
  #v(0.8em)
  #text(size: 1.15em, fill: rgb("#374151"), doc.question)
  #v(1.6em)
  #text(size: 0.95em, fill: muted, datetime.today().display("[year]-[month]-[day]"))
  #v(2fr)
  #pagebreak()
] else [
  #text(size: 1.7em, weight: "bold", fill: accent, doc.title)
  #v(0.3em)
  #text(size: 1.05em, fill: rgb("#374151"), doc.question)
  #v(0.4em)
  #line(length: 100%, stroke: 1.5pt + accent)
  #v(0.8em)
]

#heading(level: 1, text("Summary"))
#par(text(doc.summary))

#heading(level: 1, text("Key Findings"))
#enum(
  ..doc.keyFindings.map(item => [
    #text(item.text) #super(text("[" + item.sources.map(str).join(", ") + "]"))
  ])
)

#for sec in doc.sections [
  #heading(level: 1)[
    #text(sec.heading)#if sec.sources.len() > 0 [ #super(text("[" + sec.sources.map(str).join(", ") + "]"))]
  ]
  #render-body(sec.body)
]

#if doc.limitations.len() > 0 [
  #heading(level: 1, text("Limitations"))
  #list(..doc.limitations.map(item => text(item)))
]

#if fmt.sourcesAppendix and doc.sources.len() > 0 [
  #heading(level: 1, text("Sources"))
  #for s in doc.sources [
    #block(breakable: false, below: 0.6em)[
      #text(str(s.n) + ". ")#text(weight: "bold", s.title)#text(" — " + s.domain + " — ")#link(s.url, text(s.url))#text(" — " + s.accessedAt.split(regex("[Tt]")).at(0))
    ]
  ]
]
