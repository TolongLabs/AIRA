# Skills

Skills are packaged instructions an agent loads when a task calls for them. They are installed in `.agents/skills/`,
and `.claude/skills/` holds one link per skill.

## Installed

`mattpocock/skills`: engineering process skills, 27 in all. They cover specs and tickets, test-driven development,
bug diagnosis, code review, codebase design, domain modeling, handoffs and research.

- [mattpocock/skills on GitHub](https://github.com/mattpocock/skills)

## Restore Or Update

`skills-lock.json` records each skill's source and content hash.

```bash
bunx skills experimental_install   # restore every skill in the lock
bunx skills update -p              # update project skills and the lock
```

After adding or removing a skill, add or remove its link under `.claude/skills/`.

## Rules

- Review a skill before use. Skills run with the agent's full permissions.
- Do not edit files under `.agents/skills/`. Change a skill at its source, then update.
