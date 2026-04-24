from types import ModuleType

from .templates import amex, chase_cc, mercury, ramp, svb, wise


class NoTemplateMatch(Exception):
    pass


TEMPLATES: list[ModuleType] = [svb, ramp, mercury, chase_cc, amex, wise]


def detect(header: list[str]) -> ModuleType:
    for tpl in TEMPLATES:
        if tpl.match(header):
            return tpl
    names = [getattr(t, "NAME", t.__name__.rsplit(".", 1)[-1]) for t in TEMPLATES]
    raise NoTemplateMatch(
        f"No parser template matched. Tried: {names}. Header columns: {header}"
    )
