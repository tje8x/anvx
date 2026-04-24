from collections.abc import Iterable, Iterator

from ..parsed_transaction import ParsedTransaction

NAME = "chase_cc"


def match(header: list[str]) -> bool:
    return False


def parse(rows: Iterable[list[str]], header: list[str]) -> Iterator[ParsedTransaction]:
    yield from ()
